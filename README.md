# ghost-storage-r2

[![CI](https://github.com/toutouer/ghost-storage-r2/actions/workflows/ci.yml/badge.svg)](https://github.com/toutouer/ghost-storage-r2/actions/workflows/ci.yml)

A lightweight, production-hardened **Cloudflare R2 & S3-compatible storage adapter** for **Ghost 5.x & 6.x** (Node.js ≥ 20).

Designed to mirror Ghost's native local storage layout (`images`, `media`, `files`) 1:1 in object storage—so **Ghost's built-in responsive images, WebP/AVIF variants, video thumbnails, and large file downloads** work seamlessly without hacks.

---

## Why `ghost-storage-r2`?

Most Ghost S3 adapters either flatten paths into a single directory, break Ghost's local responsive image pipeline, lose video thumbnails, or trigger subtle HTTP streaming bugs on Ghost 6 + Cloudflare R2. This adapter solves all of them cleanly:

- **1:1 Native Ghost Directory Layout & Responsive Images**
  - Supports separate `pathPrefix` per asset category (`content/images`, `content/media`, `content/files`) with automatic prefix deduplication (`resolveKey`), preventing doubled paths when Ghost reads/writes thumbnails or resized variants.
  - Because bucket keys match Ghost's local disk structure and serve under your primary domain (`assetHost`), **Ghost's native responsive images (`/content/images/size/w.../format/webp/...`), WebP/AVIF conversion, and video upload thumbnails work out of the box**.
  - Switching between local disk and R2 is a pure file sync—zero URL rewriting required.
- **Built Specifically for Cloudflare R2 & AWS SDK v3**
  - Uses modular `@aws-sdk/client-s3` v3 with only **2 runtime dependencies** (fast install, minimal memory footprint on small VPSes).
  - Disables AWS SDK v3 default flexible checksum headers (`requestChecksumCalculation` / `responseChecksumValidation: 'WHEN_REQUIRED'`) that break uploads on Cloudflare R2.
  - Intentionally omits legacy S3 `ACL` headers incompatible with R2.

---

## Bucket Structure (Mirrors Ghost Local Disk)

```text
<your-r2-bucket>/
└── content/
    ├── images/
    │   ├── 2026/06/banner.jpg
    │   └── size/
    │       ├── w1200/2026/06/banner.jpg
    │       └── w600/format/webp/2026/06/banner.jpg
    ├── media/
    │   └── 2026/06/demo.mp4          # video + generated thumbnail intact
    └── files/
        └── 2026/06/archive.zip       # full Content-Length + Range support
```

---

## Quick Start (Docker Compose / Dockge / Portainer)

### 1. Environment Variables (3-Tier Isolation + Native Responsive Images)

Pair the shared `storage__s3__*` credentials with per-category `pathPrefix` and your primary domain as `assetHost`:

```yaml
services:
  ghost:
    image: ghost:6-alpine
    volumes:
      - ghost-content:/var/lib/ghost/content
    environment:
      url: https://www.example.com

      # Base R2 / S3 connection
      storage__active: s3
      storage__s3__endpoint: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
      storage__s3__region: auto
      storage__s3__bucket: your-r2-bucket
      storage__s3__accessKeyId: ${R2_ACCESS_KEY_ID}
      storage__s3__secretAccessKey: ${R2_SECRET_ACCESS_KEY}
      storage__s3__forcePathStyle: "true"
      storage__s3__assetHost: https://www.example.com

      # 3-tier path mirroring (enables native responsive images & thumbnails)
      storage__images__adapter: s3
      storage__images__pathPrefix: content/images
      storage__images__assetHost: https://www.example.com

      storage__media__adapter: s3
      storage__media__pathPrefix: content/media
      storage__media__assetHost: https://www.example.com

      storage__files__adapter: s3
      storage__files__pathPrefix: content/files
      storage__files__assetHost: https://www.example.com
```

### 2. Install the Adapter into Ghost

Because pre-compiled `index.js` is kept in sync by CI, you do not need TypeScript on your server. Pick either deployment style:

#### Option A: One-Shot Setup Service (Official `ghost:6-alpine`, Zero Custom Image)

Add a `tools`-profile helper alongside your `ghost` service and run `docker compose --profile tools run --rm ghost-s3-setup` whenever installing or upgrading:

```yaml
  ghost-s3-setup:
    image: node:22-alpine
    profiles: ["tools"]
    restart: "no"
    volumes:
      - ghost-content:/ghost-content
    entrypoint: ["/bin/sh", "-c"]
    command:
      - |
        set -e
        rm -rf /ghost-content/adapters/storage/s3
        mkdir -p /ghost-content/adapters/storage/s3
        cd /ghost-content/adapters/storage/s3
        wget -qO- https://github.com/toutouer/ghost-storage-r2/archive/refs/heads/main.tar.gz | tar xz --strip-components=1
        npm ci --omit=dev --ignore-scripts
        chmod -R 755 /ghost-content/adapters
        node -c /ghost-content/adapters/storage/s3/index.js
```

#### Option B: Custom Image via `paths__installedAdaptersPath`

Keeps the adapter baked into the image outside `/var/lib/ghost/content`:

```dockerfile
FROM ghost:6-alpine
WORKDIR /opt/ghost-adapters/storage/s3
COPY package.json package-lock.json index.js ./
RUN npm ci --omit=dev --ignore-scripts
WORKDIR /var/lib/ghost
ENV paths__installedAdaptersPath=/opt/ghost-adapters
```

---

## Configuration Options

| Option | Required | Default | Description |
| :--- | :---: | :--- | :--- |
| `bucket` | Yes | — | R2 / S3 bucket name. |
| `endpoint` | No | — | R2 S3 endpoint (`https://<ACCOUNT_ID>.r2.cloudflarestorage.com`). |
| `region` | No | `'auto'` | Region slug (`'auto'` for Cloudflare R2). |
| `accessKeyId` | No | AWS chain | R2 / S3 Access Key ID. |
| `secretAccessKey` | No | AWS chain | R2 / S3 Secret Access Key. |
| `forcePathStyle` | No | `Boolean(endpoint)` | Use path-style URLs (`true` when `endpoint` is set). |
| `assetHost` | No | S3 URL | Public domain prefix (set to your primary Ghost URL for responsive images). |
| `pathPrefix` | No | `''` | Key prefix inside the bucket (e.g., `content/images`, `content/media`, `content/files`). |
| `serveMode` | No | `'direct'` | `'direct'` (stream via Ghost with `HEAD`/`Range`/`no-transform`) or `'redirect'` (`301` to `assetHost`). |

> **Cloudflare 100 MB Upload Cap**: Cloudflare Free/Pro proxy caps HTTP upload bodies at 100 MB (`413 Payload Too Large`) before traffic reaches Ghost. For uploads > 100 MB through Ghost Admin, configure a separate `admin__url` routed directly to your origin (DNS-only + IP allowlist or private VPN).

---

## Development & CI

```bash
npm ci
npm run check   # prettier check + tsc typecheck + tsc build + node --test
```

- **CI (`.github/workflows/ci.yml`)**: Runs formatting, TypeScript typecheck, build, and zero-dependency `node --test` unit tests on **Node 20 & 22** on every push and PR. On direct pushes to `main` (e.g., edits via GitHub Web UI), CI automatically rebuilds and commits `index.js` once all checks pass.
- **Dependabot (`.github/dependabot.yml`)**: Checks npm and GitHub Actions updates monthly and validates every PR against CI.

---

## License & Attribution

[ISC](./LICENSE.md) — Originally evolved from [laosb/ghos3](https://github.com/laosb/ghos3) and [colinmeinke/ghost-storage-adapter-s3](https://github.com/colinmeinke/ghost-storage-adapter-s3), now independently maintained and modernized for Cloudflare R2 and Ghost 6.x.
