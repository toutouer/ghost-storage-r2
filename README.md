# ghost-storage-r2

Cloudflare R2 & S3-compatible storage adapter for **Ghost 5.x & 6.x** (Node.js >= 20).

This project originally evolved from [laosb/ghos3](https://github.com/laosb/ghos3) (which modernized [colinmeinke/ghost-storage-adapter-s3](https://github.com/colinmeinke/ghost-storage-adapter-s3)) and is now maintained as an independent repository tailored for Cloudflare R2 and Docker / Portainer deployments.

## Features

- Built on AWS SDK v3 (`@aws-sdk/client-s3`) with Cloudflare R2 flexible checksum compatibility (`requestChecksumCalculation` / `responseChecksumValidation: 'WHEN_REQUIRED'`).
- Two serving modes via `serveMode`:
  - `direct` (default): Streams objects through Ghost with HTTP `Range` (`206 Partial Content`) support for audio/video seeking and clean stream teardown on client disconnect.
  - `redirect`: Returns `301` redirects directly to `${assetHost}/${key}`.
- Automatic `Content-Length` detection, MIME mapping (including WebP/AVIF responsive paths), `Cache-Control: public, max-age=31536000, immutable`, and path traversal protection.
- Proper `ENOENT` / `404` handling for Ghost internal `read()` and `exists()` checks, plus safe `delete()` handling for historical `YYYY/MM` paths.

---

## Configuration

### Options

| Option | Required | Default | Description |
| --- | --- | --- | --- |
| `bucket` | Yes | — | R2 / S3 bucket name. |
| `accessKeyId` | No | AWS credential chain | R2 S3 API Access Key ID. |
| `secretAccessKey` | No | AWS credential chain | R2 S3 API Secret Access Key. |
| `region` | No | `'auto'` | Region slug (Cloudflare R2 uses `'auto'`). |
| `endpoint` | No | — | R2 S3 endpoint, e.g. `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. |
| `forcePathStyle` | No | `Boolean(endpoint)` | Use path-style S3 URLs (`true` by default when `endpoint` is set). |
| `assetHost` | No | S3 URL | Public CDN / R2 custom domain URL (e.g. `https://cdn.example.com`). |
| `pathPrefix` | No | `''` | Optional subdirectory prefix inside the bucket. |
| `serveMode` | No | `'direct'` | `'direct'` (proxy stream with `Range`) or `'redirect'` (`301` to `assetHost`). |

> Note: Traditional S3 `acl` is intentionally not used, as Cloudflare R2 manages public access at the bucket/custom-domain level.

### `config.production.json` example

If you install the adapter under `r2` (e.g. `adapters/storage/r2/index.js`):

```json
{
  "storage": {
    "active": "r2",
    "images": {
      "adapter": "r2"
    },
    "media": {
      "adapter": "r2"
    },
    "files": {
      "adapter": "r2"
    },
    "r2": {
      "bucket": "your-r2-bucket",
      "region": "auto",
      "endpoint": "https://<ACCOUNT_ID>.r2.cloudflarestorage.com",
      "accessKeyId": "YOUR_R2_ACCESS_KEY_ID",
      "secretAccessKey": "YOUR_R2_SECRET_ACCESS_KEY",
      "assetHost": "https://cdn.example.com",
      "pathPrefix": "",
      "forcePathStyle": true,
      "serveMode": "direct"
    }
  }
}
```

> Tip: If you want Ghost's local responsive image optimization (`/content/images/size/...`) without extra CDN image-resizing setup, you can keep `images` on Ghost's default local storage and only configure `storage.media` and `storage.files` to use `r2` (omit `storage.active` and `storage.images`).

---

## Deployment in Docker / Portainer

Because `index.js` is compiled directly from TypeScript (`tsc`) without bundling `@aws-sdk/client-s3`, runtime dependencies (`node_modules`) must be present alongside the adapter (or resolvable via `NODE_PATH`).

### Recommended: Custom Image with `paths__installedAdaptersPath`

Using Ghost's `paths__installedAdaptersPath` keeps your adapter outside `/var/lib/ghost/content` so it will never be shadowed or overwritten by Docker content volumes.

1. Build the adapter locally or in CI:

```bash
npm ci
npm run build
```

2. `Dockerfile` example:

```dockerfile
FROM ghost:6-alpine
# Or ghost:5-alpine for Ghost 5.x

WORKDIR /opt/ghost-adapters/storage/r2
COPY package.json package-lock.json index.js ./
RUN npm ci --omit=dev

WORKDIR /var/lib/ghost
ENV paths__installedAdaptersPath=/opt/ghost-adapters
```

3. Portainer Stack (`docker-compose.yml`) environment variables:

```yaml
services:
  ghost:
    image: your-registry/ghost-r2:latest
    environment:
      url: https://blog.example.com
      # Optional: separate admin domain to bypass Cloudflare's 100MB upload cap (see below)
      # admin__url: https://admin.example.com
      paths__installedAdaptersPath: /opt/ghost-adapters
      storage__active: r2
      storage__media__adapter: r2
      storage__files__adapter: r2
      storage__r2__bucket: your-r2-bucket
      storage__r2__region: auto
      storage__r2__endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
      storage__r2__accessKeyId: YOUR_R2_ACCESS_KEY_ID
      storage__r2__secretAccessKey: YOUR_R2_SECRET_ACCESS_KEY
      storage__r2__assetHost: https://cdn.example.com
      storage__r2__serveMode: direct
    volumes:
      - ghost_content:/var/lib/ghost/content
```

### Alternative: Bind Mount into `content/adapters/storage/r2`

If you use the official `ghost` Docker image directly:

1. Prepare a directory on the host containing `index.js`, `package.json`, `package-lock.json`, and run `npm ci --omit=dev` inside it.
2. Mount that directory into `/var/lib/ghost/content/adapters/storage/r2` in your Portainer stack and pass the same `storage__*` environment variables above.

---

## Note on Cloudflare's 100 MB Upload Limit

Cloudflare Free/Pro proxy enforces a **100 MB** max HTTP request body (`413 Payload Too Large`) before requests reach Ghost or this storage adapter.

To upload files larger than 100 MB through Ghost Admin without switching `hosts` manually:

- Configure Ghost's built-in admin URL separation (`admin__url: https://admin.example.com`), and route that admin subdomain directly to your origin (e.g. via Tailscale/WireGuard private network or a DNS-only grey-cloud record protected by IP allowlisting—note that Cloudflare Tunnel also enforces the 100 MB proxy cap).

---

## Development

```bash
npm install
npm run typecheck
npm run build
```

## License

[ISC](./LICENSE.md) — Originally based on [ghos3](https://github.com/laosb/ghos3) by Shibo Lyu and [ghost-storage-adapter-s3](https://github.com/colinmeinke/ghost-storage-adapter-s3) by Colin Meinke.
