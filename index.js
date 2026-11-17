"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
const ghost_storage_base_1 = __importDefault(require("ghost-storage-base"));
const client_s3_1 = require("@aws-sdk/client-s3");
const fs_1 = require("fs");
const promises_1 = require("fs/promises");
const path_1 = require("path");
const MIME_MAP = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.avif': 'image/avif',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.ogv': 'video/ogg',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.pdf': 'application/pdf',
    '.zip': 'application/zip',
    '.json': 'application/json',
    '.webmanifest': 'application/manifest+json',
};
class InvalidPathError extends Error {
    statusCode = 400;
    errorType = 'BadRequestError';
    constructor(message) {
        super(message);
        this.name = 'InvalidPathError';
    }
}
function getContentType(filePath, explicitType) {
    if (explicitType && explicitType !== 'application/octet-stream') {
        return explicitType;
    }
    if (filePath && filePath.includes('/format/webp/'))
        return 'image/webp';
    if (filePath && filePath.includes('/format/avif/'))
        return 'image/avif';
    const ext = (0, path_1.extname)((filePath || '').split(/[?#]/)[0]).toLowerCase();
    return MIME_MAP[ext] || explicitType || 'application/octet-stream';
}
const stripLeadingAndTrailingSlashes = (str) => str.replace(/^\/+|\/+$/g, '');
const stripEndingSlash = (str) => str.replace(/\/+$/, '');
function assertNoTraversal(value) {
    const normalized = (value || '').replace(/\\/g, '/');
    if (normalized.split('/').includes('..')) {
        throw new InvalidPathError(`Invalid storage path: ${value}`);
    }
    return normalized;
}
function isNotFoundError(err) {
    if (!err)
        return false;
    return Boolean(err.name === 'NoSuchKey' ||
        err.name === 'NotFound' ||
        err.Code === 'NoSuchKey' ||
        (err.$metadata && err.$metadata.httpStatusCode === 404));
}
class S3Storage extends ghost_storage_base_1.default {
    client;
    bucket;
    pathPrefix;
    host;
    serveMode;
    constructor(config = {}) {
        super();
        if (!config.bucket)
            throw new Error('S3 bucket not specified');
        this.client = new client_s3_1.S3Client({
            region: config.region || 'auto',
            credentials: config.accessKeyId && config.secretAccessKey
                ? {
                    accessKeyId: config.accessKeyId,
                    secretAccessKey: config.secretAccessKey,
                }
                : undefined,
            endpoint: config.endpoint,
            forcePathStyle: config.forcePathStyle ?? Boolean(config.endpoint),
            // Cloudflare R2 does not support AWS SDK v3 default flexible checksum headers
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED',
        });
        this.bucket = config.bucket;
        this.pathPrefix = stripLeadingAndTrailingSlashes(config.pathPrefix || '');
        const defaultHost = `https://s3.${config.region ? `${config.region}.` : ''}amazonaws.com/${config.bucket}`;
        this.host = stripEndingSlash(config.assetHost || defaultHost);
        this.serveMode = config.serveMode || 'direct';
    }
    urlToPath(url) {
        if (url && url.startsWith(this.host)) {
            return url.substring(this.host.length).split(/[?#]/)[0];
        }
        try {
            return new URL(url).pathname;
        }
        catch {
            return url;
        }
    }
    resolveKey(fileName, targetDir) {
        const safeFileName = assertNoTraversal(fileName);
        const safeTargetDir = assertNoTraversal(targetDir);
        const joined = safeTargetDir
            ? path_1.posix.join(safeTargetDir, safeFileName)
            : safeFileName;
        const cleaned = stripLeadingAndTrailingSlashes(joined);
        if (!this.pathPrefix)
            return cleaned;
        if (cleaned === this.pathPrefix ||
            cleaned.startsWith(this.pathPrefix + '/')) {
            return cleaned;
        }
        return stripLeadingAndTrailingSlashes(path_1.posix.join(this.pathPrefix, cleaned));
    }
    async delete(fileName, targetDir) {
        try {
            const cleanedName = stripLeadingAndTrailingSlashes(assertNoTraversal(fileName));
            const hasDir = cleanedName.includes('/') ||
                (this.pathPrefix !== '' &&
                    (cleanedName === this.pathPrefix ||
                        cleanedName.startsWith(this.pathPrefix + '/')));
            const dir = targetDir || (hasDir ? undefined : this.getTargetDir(this.pathPrefix));
            const target = this.resolveKey(fileName, dir);
            await this.client.send(new client_s3_1.DeleteObjectCommand({
                Bucket: this.bucket,
                Key: target,
            }));
        }
        catch {
            return false;
        }
        return true;
    }
    async exists(fileName, targetDir) {
        try {
            const key = this.resolveKey(fileName, targetDir);
            await this.client.send(new client_s3_1.HeadObjectCommand({
                Bucket: this.bucket,
                Key: key,
            }));
        }
        catch {
            return false;
        }
        return true;
    }
    async save(image, targetDir) {
        const dir = targetDir || this.getTargetDir(this.pathPrefix);
        const targetRelative = await this.getUniqueFileName(image, dir);
        const key = this.resolveKey(targetRelative);
        const { size } = await (0, promises_1.stat)(image.path);
        const file = (0, fs_1.createReadStream)(image.path);
        try {
            await this.client.send(new client_s3_1.PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: file,
                ContentLength: size,
                ContentType: getContentType(image.name || image.path, image.type),
                CacheControl: 'public, max-age=31536000, immutable',
            }));
        }
        finally {
            file.destroy();
        }
        return `${this.host}/${key}`;
    }
    async saveRaw(buffer, targetPath) {
        const key = this.resolveKey(targetPath);
        await this.client.send(new client_s3_1.PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: buffer,
            ContentLength: buffer.length,
            ContentType: getContentType(targetPath),
            CacheControl: 'public, max-age=31536000, immutable',
        }));
        return `${this.host}/${key}`;
    }
    serve() {
        return async (req, res, next) => {
            try {
                const key = this.resolveKey(decodeURIComponent(req.path));
                if (this.serveMode === 'redirect') {
                    res.redirect(301, encodeURI(`${this.host}/${key}`));
                    return;
                }
                const params = {
                    Bucket: this.bucket,
                    Key: key,
                };
                if (req.headers.range) {
                    params.Range = req.headers.range;
                }
                const out = await this.client.send(new client_s3_1.GetObjectCommand(params));
                const stream = out.Body;
                if (!stream) {
                    res.status(404).end();
                    return;
                }
                const headers = {
                    'Cache-Control': 'public, max-age=31536000, immutable',
                    'Content-Type': out.ContentType || getContentType(key),
                    'Accept-Ranges': out.AcceptRanges || 'bytes',
                };
                if (out.ContentLength !== undefined) {
                    headers['Content-Length'] = String(out.ContentLength);
                }
                if (out.ContentRange)
                    headers['Content-Range'] = out.ContentRange;
                if (out.ETag)
                    headers['ETag'] = out.ETag;
                res.status(out.ContentRange ? 206 : 200).set(headers);
                stream.on('error', (streamErr) => {
                    if (!res.headersSent) {
                        if (isNotFoundError(streamErr)) {
                            res.status(404).end();
                            return;
                        }
                        next(streamErr);
                        return;
                    }
                    res.destroy(streamErr);
                });
                res.on('close', () => {
                    if (!res.writableEnded && typeof stream.destroy === 'function') {
                        stream.destroy();
                    }
                });
                stream.pipe(res);
            }
            catch (e) {
                if (e instanceof URIError || e instanceof InvalidPathError) {
                    res.status(400).end();
                    return;
                }
                if (isNotFoundError(e)) {
                    res.status(404).end();
                    return;
                }
                next(e);
            }
        };
    }
    async read(options = { path: '' }) {
        let path = (options.path || '').replace(/\/+$/, '');
        if (path.startsWith(this.host)) {
            path = path.substring(this.host.length);
        }
        const key = this.resolveKey(path);
        try {
            const out = await this.client.send(new client_s3_1.GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
            }));
            const data = await out.Body?.transformToByteArray();
            return Buffer.from(data || []);
        }
        catch (err) {
            if (isNotFoundError(err)) {
                err.code = 'ENOENT';
                err.errorType = 'NotFoundError';
                err.statusCode = 404;
            }
            throw err;
        }
    }
}
module.exports = S3Storage;
