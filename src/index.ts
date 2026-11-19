import BaseAdapter, { Image, ReadOptions } from 'ghost-storage-base'
import {
  DeleteObjectCommand,
  GetObjectCommand,
  GetObjectCommandInput,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createReadStream } from 'fs'
import { stat } from 'fs/promises'
import { extname, posix } from 'path'
import type { Handler } from 'express'
import type { Readable } from 'stream'

type Config = {
  accessKeyId?: string
  assetHost?: string
  bucket?: string
  pathPrefix?: string
  region?: string
  secretAccessKey?: string
  endpoint?: string
  forcePathStyle?: boolean
  serveMode?: 'direct' | 'redirect'
}

const MIME_MAP: Record<string, string> = {
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
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.epub': 'application/epub+zip',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx':
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
}

const COMPRESSIBLE_CONTENT_TYPES = new Set([
  'image/svg+xml',
  'application/json',
  'application/manifest+json',
])

const BASE_CACHE_CONTROL = 'public, max-age=31536000, immutable'

class InvalidPathError extends Error {
  statusCode = 400
  errorType = 'BadRequestError'

  constructor(message: string) {
    super(message)
    this.name = 'InvalidPathError'
  }
}

function getContentType(filePath?: string, explicitType?: string): string {
  const normalizedExplicit = explicitType?.split(';')[0].trim().toLowerCase()
  if (
    explicitType &&
    normalizedExplicit &&
    normalizedExplicit !== 'application/octet-stream' &&
    normalizedExplicit !== 'binary/octet-stream'
  ) {
    return explicitType
  }
  if (filePath && filePath.includes('/format/webp/')) return 'image/webp'
  if (filePath && filePath.includes('/format/avif/')) return 'image/avif'
  const ext = extname((filePath || '').split(/[?#]/)[0]).toLowerCase()
  return MIME_MAP[ext] || explicitType || 'application/octet-stream'
}

function isTextLikeContentType(contentType: string): boolean {
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return mime.startsWith('text/') || COMPRESSIBLE_CONTENT_TYPES.has(mime)
}

function getCacheControl(contentType: string): string {
  // RFC 9111: mark non-text/binary payloads `no-transform` so downstream
  // compression middleware (e.g. Ghost Express compression) and proxies
  // never re-compress binaries or strip Content-Length.
  return isTextLikeContentType(contentType)
    ? BASE_CACHE_CONTROL
    : `${BASE_CACHE_CONTROL}, no-transform`
}

type ObjectMetadata = {
  ContentType?: string
  AcceptRanges?: string
  ContentLength?: number
  ContentRange?: string
  ETag?: string
  LastModified?: Date
}

function buildObjectHeaders(
  key: string,
  meta: ObjectMetadata
): Record<string, string> {
  const contentType = getContentType(key, meta.ContentType)
  const headers: Record<string, string> = {
    'Cache-Control': getCacheControl(contentType),
    'Content-Type': contentType,
    'Accept-Ranges': meta.AcceptRanges || 'bytes',
  }
  if (meta.ContentLength !== undefined) {
    headers['Content-Length'] = String(meta.ContentLength)
  }
  if (meta.ContentRange) headers['Content-Range'] = meta.ContentRange
  if (meta.ETag) headers['ETag'] = meta.ETag
  if (meta.LastModified instanceof Date) {
    headers['Last-Modified'] = meta.LastModified.toUTCString()
  }
  return headers
}

const stripLeadingAndTrailingSlashes = (str: string) =>
  str.replace(/^\/+|\/+$/g, '')
const stripEndingSlash = (str: string) => str.replace(/\/+$/, '')

function assertNoTraversal(value?: string): string {
  const normalized = (value || '').replace(/\\/g, '/')
  if (normalized.split('/').includes('..')) {
    throw new InvalidPathError(`Invalid storage path: ${value}`)
  }
  return normalized
}

function isNotFoundError(err: any): boolean {
  if (!err) return false
  return Boolean(
    err.name === 'NoSuchKey' ||
    err.name === 'NotFound' ||
    err.Code === 'NoSuchKey' ||
    (err.$metadata && err.$metadata.httpStatusCode === 404)
  )
}

function isRangeNotSatisfiableError(err: any): boolean {
  if (!err) return false
  return Boolean(
    err.name === 'InvalidRange' ||
    err.Code === 'InvalidRange' ||
    (err.$metadata && err.$metadata.httpStatusCode === 416)
  )
}

class S3Storage extends BaseAdapter {
  private client: S3Client
  private bucket: string
  private pathPrefix: string
  private host: string
  private serveMode: 'direct' | 'redirect'

  constructor(config: Config = {}) {
    super()
    if (!config.bucket) throw new Error('S3 bucket not specified')
    this.client = new S3Client({
      region: config.region || 'auto',
      credentials:
        config.accessKeyId && config.secretAccessKey
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
    })
    this.bucket = config.bucket
    this.pathPrefix = stripLeadingAndTrailingSlashes(config.pathPrefix || '')
    const defaultHost = `https://s3.${config.region ? `${config.region}.` : ''}amazonaws.com/${config.bucket}`
    this.host = stripEndingSlash(config.assetHost || defaultHost)
    this.serveMode = config.serveMode || 'direct'
  }

  urlToPath(url: string): string {
    if (url && url.startsWith(this.host)) {
      return url.substring(this.host.length).split(/[?#]/)[0]
    }
    try {
      return new URL(url).pathname
    } catch {
      return url
    }
  }

  resolveKey(fileName?: string, targetDir?: string): string {
    const safeFileName = assertNoTraversal(fileName)
    const safeTargetDir = assertNoTraversal(targetDir)
    const joined = safeTargetDir
      ? posix.join(safeTargetDir, safeFileName)
      : safeFileName
    const cleaned = stripLeadingAndTrailingSlashes(joined)
    if (!this.pathPrefix) return cleaned
    if (
      cleaned === this.pathPrefix ||
      cleaned.startsWith(this.pathPrefix + '/')
    ) {
      return cleaned
    }
    return stripLeadingAndTrailingSlashes(posix.join(this.pathPrefix, cleaned))
  }

  async delete(fileName: string, targetDir?: string): Promise<boolean> {
    try {
      const cleanedName = stripLeadingAndTrailingSlashes(
        assertNoTraversal(fileName)
      )
      const hasDir =
        cleanedName.includes('/') ||
        (this.pathPrefix !== '' &&
          (cleanedName === this.pathPrefix ||
            cleanedName.startsWith(this.pathPrefix + '/')))
      const dir =
        targetDir || (hasDir ? undefined : this.getTargetDir(this.pathPrefix))
      const target = this.resolveKey(fileName, dir)
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: target,
        })
      )
    } catch {
      return false
    }
    return true
  }

  async exists(fileName: string, targetDir?: string): Promise<boolean> {
    try {
      const key = this.resolveKey(fileName, targetDir)
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      )
    } catch {
      return false
    }
    return true
  }

  async save(image: Image, targetDir?: string): Promise<string> {
    const dir = targetDir || this.getTargetDir(this.pathPrefix)
    const targetRelative = await this.getUniqueFileName(image, dir)
    const key = this.resolveKey(targetRelative)
    const { size } = await stat(image.path)
    const contentType = getContentType(image.name || image.path, image.type)
    const file = createReadStream(image.path)
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: file,
          ContentLength: size,
          ContentType: contentType,
          CacheControl: getCacheControl(contentType),
        })
      )
    } finally {
      file.destroy()
    }
    return `${this.host}/${key}`
  }

  async saveRaw(buffer: Buffer, targetPath: string): Promise<string> {
    const key = this.resolveKey(targetPath)
    const contentType = getContentType(targetPath)
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: buffer,
        ContentLength: buffer.length,
        ContentType: contentType,
        CacheControl: getCacheControl(contentType),
      })
    )
    return `${this.host}/${key}`
  }

  serve(): Handler {
    return async (req, res, next) => {
      try {
        const key = this.resolveKey(decodeURIComponent(req.path))
        if (this.serveMode === 'redirect') {
          res.redirect(301, encodeURI(`${this.host}/${key}`))
          return
        }

        if (req.method === 'HEAD') {
          const head = await this.client.send(
            new HeadObjectCommand({
              Bucket: this.bucket,
              Key: key,
            })
          )
          res.status(200).set(buildObjectHeaders(key, head)).end()
          return
        }

        const params: GetObjectCommandInput = {
          Bucket: this.bucket,
          Key: key,
        }
        if (req.headers.range) {
          params.Range = req.headers.range
        }
        const out = await this.client.send(new GetObjectCommand(params))
        const stream = out.Body as Readable | undefined
        if (!stream) {
          res.status(404).end()
          return
        }

        res
          .status(out.ContentRange ? 206 : 200)
          .set(buildObjectHeaders(key, out))

        stream.on('error', (streamErr) => {
          if (!res.headersSent) {
            if (isNotFoundError(streamErr)) {
              res.status(404).end()
              return
            }
            next(streamErr)
            return
          }
          res.destroy(streamErr)
        })
        res.on('close', () => {
          if (!res.writableEnded && typeof stream.destroy === 'function') {
            stream.destroy()
          }
        })
        stream.pipe(res)
      } catch (e) {
        if (e instanceof URIError || e instanceof InvalidPathError) {
          res.status(400).end()
          return
        }
        if (isNotFoundError(e)) {
          res.status(404).end()
          return
        }
        if (isRangeNotSatisfiableError(e)) {
          res.status(416).end()
          return
        }
        next(e)
      }
    }
  }

  async read(options: ReadOptions = { path: '' }): Promise<Buffer> {
    let path = (options.path || '').replace(/\/+$/, '')
    if (path.startsWith(this.host)) {
      path = path.substring(this.host.length)
    }
    const key = this.resolveKey(path)
    try {
      const out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
        })
      )
      const data = await out.Body?.transformToByteArray()
      return Buffer.from(data || [])
    } catch (err: any) {
      if (isNotFoundError(err)) {
        err.code = 'ENOENT'
        err.errorType = 'NotFoundError'
        err.statusCode = 404
      }
      throw err
    }
  }
}

export = S3Storage
