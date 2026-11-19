'use strict'

const { describe, it } = require('node:test')
const assert = require('node:assert/strict')
const { Readable } = require('node:stream')
const S3Storage = require('../index.js')

function createMockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    redirectedTo: null,
    chunks: [],
    headersSent: false,
    writableEnded: false,
    destroyedWith: null,
    status(code) {
      this.statusCode = code
      return this
    },
    set(headers) {
      for (const [k, v] of Object.entries(headers)) {
        this.headers[k.toLowerCase()] = v
      }
      return this
    },
    redirect(code, url) {
      this.statusCode = code
      this.redirectedTo = url
      this.headersSent = true
      this.writableEnded = true
      return this
    },
    write(chunk) {
      this.headersSent = true
      this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return true
    },
    end(chunk) {
      if (chunk) this.write(chunk)
      this.headersSent = true
      this.writableEnded = true
      return this
    },
    on() {},
    once() {},
    emit() {},
    destroy(err) {
      this.destroyedWith = err || true
    },
  }
  return res
}

function createStorage(sendImpl, config = {}) {
  const storage = new S3Storage({
    bucket: 'test-bucket',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    assetHost: 'https://www.example.com',
    pathPrefix: 'content/files',
    ...config,
  })
  storage.client = { send: sendImpl }
  return storage
}

describe('ghost-storage-r2', () => {
  it('resolves keys cleanly and prevents path traversal', () => {
    const storage = createStorage(async () => ({}))
    assert.equal(
      storage.resolveKey('2026/01/test.zip'),
      'content/files/2026/01/test.zip'
    )
    assert.equal(
      storage.resolveKey('content/files/2026/01/test.zip'),
      'content/files/2026/01/test.zip'
    )
    assert.throws(
      () => storage.resolveKey('../secret.env'),
      (err) => err.statusCode === 400
    )
  })

  it('extracts path from assetHost or external URL via urlToPath', () => {
    const storage = createStorage(async () => ({}))
    assert.equal(
      storage.urlToPath(
        'https://www.example.com/content/files/2026/01/a.pdf?v=1'
      ),
      '/content/files/2026/01/a.pdf'
    )
    assert.equal(
      storage.urlToPath('https://cdn.other.com/content/images/a.webp'),
      '/content/images/a.webp'
    )
  })

  it('handles HEAD via HeadObjectCommand and fixes legacy octet-stream ZIP MIME + no-transform', async () => {
    const seen = []
    const lastMod = new Date('2026-10-13T06:55:54Z')
    const storage = createStorage(async (cmd) => {
      seen.push(cmd.constructor.name)
      return {
        ContentType: 'application/octet-stream',
        ContentLength: 121381613,
        ETag: '"zip-etag"',
        LastModified: lastMod,
      }
    })

    const res = createMockRes()
    await storage.serve()(
      { method: 'HEAD', path: '/2026/01/Cambridge-IELTS-07.zip', headers: {} },
      res,
      (err) => {
        throw err
      }
    )

    assert.deepEqual(seen, ['HeadObjectCommand'])
    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['content-type'], 'application/zip')
    assert.equal(res.headers['content-length'], '121381613')
    assert.equal(
      res.headers['cache-control'],
      'public, max-age=31536000, immutable, no-transform'
    )
    assert.equal(res.headers['accept-ranges'], 'bytes')
    assert.equal(res.headers['etag'], '"zip-etag"')
    assert.equal(res.headers['last-modified'], lastMod.toUTCString())
  })

  it('preserves Content-Length and no-transform on legacy octet-stream PDF and unknown binaries', async () => {
    const storage = createStorage(async () => ({
      ContentType: 'application/octet-stream',
      ContentLength: 5,
      Body: Readable.from([Buffer.from('hello')]),
    }))

    const pdfRes = createMockRes()
    await storage.serve()(
      { method: 'GET', path: '/2026/06/book.pdf', headers: {} },
      pdfRes,
      (err) => {
        throw err
      }
    )
    assert.equal(pdfRes.headers['content-type'], 'application/pdf')
    assert.equal(pdfRes.headers['content-length'], '5')
    assert.match(pdfRes.headers['cache-control'], /\bno-transform\b/)

    const unknownRes = createMockRes()
    await storage.serve()(
      { method: 'GET', path: '/2026/06/data.custombin', headers: {} },
      unknownRes,
      (err) => {
        throw err
      }
    )
    assert.equal(unknownRes.headers['content-type'], 'application/octet-stream')
    assert.match(unknownRes.headers['cache-control'], /\bno-transform\b/)
  })

  it('infers responsive WebP/AVIF formats and keeps SVG/text compressible', async () => {
    const imgStorage = createStorage(
      async (cmd) => ({
        ContentType: cmd.input.Key.endsWith('.svg')
          ? 'image/svg+xml'
          : 'binary/octet-stream',
        ContentLength: 4,
        Body: Readable.from([Buffer.from('test')]),
      }),
      { pathPrefix: 'content/images' }
    )

    const webpRes = createMockRes()
    await imgStorage.serve()(
      { method: 'GET', path: '/size/w600/format/webp/2026/06/a.jpg', headers: {} },
      webpRes,
      (err) => {
        throw err
      }
    )
    assert.equal(webpRes.headers['content-type'], 'image/webp')
    assert.match(webpRes.headers['cache-control'], /\bno-transform\b/)

    const svgRes = createMockRes()
    await imgStorage.serve()(
      { method: 'GET', path: '/2026/06/logo.svg', headers: {} },
      svgRes,
      (err) => {
        throw err
      }
    )
    assert.equal(svgRes.headers['content-type'], 'image/svg+xml')
    assert.equal(
      svgRes.headers['cache-control'],
      'public, max-age=31536000, immutable'
    )
  })

  it('supports Range 206, InvalidRange 416, NotFound 404, BadPath 400, and redirect 301', async () => {
    const storage = createStorage(async (cmd) => {
      if (cmd.input.Key.endsWith('missing.zip')) {
        const e = new Error('missing')
        e.name = 'NoSuchKey'
        throw e
      }
      if (cmd.input.Range === 'bytes=999999-') {
        const e = new Error('invalid range')
        e.name = 'InvalidRange'
        throw e
      }
      return {
        ContentType: 'application/zip',
        ContentLength: 1024,
        ContentRange: 'bytes 0-1023/121381613',
        Body: Readable.from([Buffer.alloc(1024)]),
      }
    })

    const r206 = createMockRes()
    await storage.serve()(
      { method: 'GET', path: '/2026/01/a.zip', headers: { range: 'bytes=0-1023' } },
      r206,
      (err) => {
        throw err
      }
    )
    assert.equal(r206.statusCode, 206)
    assert.equal(r206.headers['content-range'], 'bytes 0-1023/121381613')

    const r416 = createMockRes()
    await storage.serve()(
      { method: 'GET', path: '/2026/01/a.zip', headers: { range: 'bytes=999999-' } },
      r416,
      (err) => {
        throw err
      }
    )
    assert.equal(r416.statusCode, 416)

    const r404 = createMockRes()
    await storage.serve()(
      { method: 'GET', path: '/2026/01/missing.zip', headers: {} },
      r404,
      (err) => {
        throw err
      }
    )
    assert.equal(r404.statusCode, 404)

    const r400 = createMockRes()
    await storage.serve()(
      { method: 'GET', path: '/../etc/passwd', headers: {} },
      r400,
      (err) => {
        throw err
      }
    )
    assert.equal(r400.statusCode, 400)

    const redirectStorage = createStorage(async () => ({}), {
      serveMode: 'redirect',
    })
    const r301 = createMockRes()
    await redirectStorage.serve()(
      { method: 'GET', path: '/2026/01/a.zip', headers: {} },
      r301,
      (err) => {
        throw err
      }
    )
    assert.equal(r301.statusCode, 301)
    assert.equal(
      r301.redirectedTo,
      'https://www.example.com/content/files/2026/01/a.zip'
    )
  })

  it('sets proper CacheControl in saveRaw and maps NoSuchKey to ENOENT in read()', async () => {
    const uploads = []
    const storage = createStorage(async (cmd) => {
      if (cmd.constructor.name === 'PutObjectCommand') {
        uploads.push(cmd.input)
        return {}
      }
      const e = new Error('not found')
      e.name = 'NoSuchKey'
      throw e
    })

    await storage.saveRaw(Buffer.from('webp-bytes'), 'size/w600/format/webp/a.jpg')
    assert.equal(uploads[0].ContentType, 'image/webp')
    assert.match(uploads[0].CacheControl, /\bno-transform\b/)

    await assert.rejects(
      () => storage.read({ path: '2026/01/missing.jpg' }),
      (err) => err.code === 'ENOENT' && err.statusCode === 404
    )
  })
})
