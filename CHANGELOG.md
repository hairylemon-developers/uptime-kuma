# Changelog

> **Private fork notice**
>
> This repository is **hairyLemon's private fork** of [Uptime Kuma](https://github.com/louislam/uptime-kuma).
> Changes here are for private use only and are **not intended to be merged directly into the upstream project**.

**Fork base:** upstream `2.5.X` (`2.5.11`)  
**Fork version:** `2.5.11-hairylemon`

## 2.5.11-hairylemon

### Added

- Environment variable `UPTIME_KUMA_DISABLE_CHROMIUM_AUTO_DOWNLOAD=1` to skip automatic Chromium installation via apt in containers when Chromium is missing. Intended for **slim** images (`base2-slim` / builds with `--build-arg BASE_IMAGE=louislam/uptime-kuma:base2-slim`), which do not ship Chromium binaries.
- **Local Kitesurf browser engine** as monitor type `real-browser-kitesurf` (separate from Chrome/Chromium `real-browser`), using official [cloudflare/kitesurf](https://github.com/cloudflare/kitesurf) on `127.0.0.1:8787`.
  - Probes use **Puppeteer** (`puppeteer-core` `connect` + `browserWSEndpoint`), matching the [upstream Kitesurf sample](https://github.com/cloudflare/kitesurf) — not Playwright `connectOverCDP` (Playwright navigation waits hang against local Kitesurf CDP).
  - Chromium `real-browser` remains on Playwright.
  - Kitesurf screenshots use viewport **1280×720** (Playwright’s default); Puppeteer’s own default is 800×600.
  - Remote Browsers have a **type** (`chromium` | `kitesurf`); each monitor type only lists matching remotes.
  - Settings → General includes Test for the local Kitesurf CDP endpoint when enabled.
  - Docker multi-stage build clones/builds official Kitesurf (pin with build-arg `KITESURF_REF`, default `2026.11.9`) into `/opt/kitesurf` (~550MB on disk; includes Cloudflare `workerd`). No third-party images/binaries.
  - Entrypoint starts Kitesurf on loopback when `UPTIME_KUMA_ENABLE_KITESURF=1` (default when `INCLUDE_KITESURF=1`). Do not publish host port `8787`.
  - Use `INCLUDE_KITESURF=0` to skip baking Kitesurf for faster local image builds.
- **AWS Lambda regional monitor** (`aws-lambda`): run HTTP, TCP ping, or DNS checks from an Uptime Kuma–managed Lambda probe in a selected AWS Region (similar to Globalping, with Region as the location).
  - Probe function is created/updated automatically in the target Region (Node.js 26.x, arm64); credentials use the default AWS credential chain.
  - Requires `UPTIME_KUMA_AWS_LAMBDA_EXECUTION_ROLE_ARN` for first-time function create. Optional `UPTIME_KUMA_AWS_LAMBDA_FUNCTION_NAME` (default `uptime-kuma-probe`).
  - Setup warnings with CloudFormation templates to create the Lambda execution role and an IAM user (download + open Console; roles/users are not created automatically).
  - Region list follows the [AWS commercial Regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html) table; Regions not enabled for the account are disabled in the UI via Account `ListRegions`.

### Environment variables (fork)

| Variable | Purpose |
| --- | --- |
| `UPTIME_KUMA_DISABLE_CHROMIUM_AUTO_DOWNLOAD` | Set to `1` to skip apt Chromium install in slim containers. |
| `UPTIME_KUMA_ENABLE_KITESURF` | Set to `1` to co-start local official Kitesurf from the entrypoint. |
| `UPTIME_KUMA_KITESURF_CDP_URL` | CDP WebSocket URL (default `ws://127.0.0.1:8787/devtools/browser`). |
| `UPTIME_KUMA_AWS_LAMBDA_EXECUTION_ROLE_ARN` | IAM role ARN the probe Lambda assumes (required to create the function). |
| `UPTIME_KUMA_AWS_LAMBDA_FUNCTION_NAME` | Optional probe function name (default `uptime-kuma-probe`). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Optional static credentials for managing/invoking the probe (or use an instance/task role). |

See also `.env.example` and CloudFormation templates under `extra/aws-lambda-probe/`.

### Docker build-args (fork)

| Build-arg | Purpose |
| --- | --- |
| `BASE_IMAGE` | Base image (default `louislam/uptime-kuma:base2`; use `base2-slim` for slim). |
| `KITESURF_REF` | Official cloudflare/kitesurf tag or commit to bake into the image (default `2026.11.9`). |
| `INCLUDE_KITESURF` | `1` (default) bake Kitesurf; `0` skip for faster builds. |

### Docker images (GHCR)

Published to `ghcr.io/hairylemon-developers/uptime-kuma` (slim release: `BASE_IMAGE=louislam/uptime-kuma:base2-slim`).

| Platform | Tags |
| --- | --- |
| `linux/arm64` | `2.5.11-hairylemon`, `2.5.11-hairylemon-slim`, `latest` |
| `linux/amd64` | `2.5.11-hairylemon`, `2.5.11-hairylemon-slim`, `2.5.11-hairylemon-kitesurf`, `latest` |

```bash
docker pull ghcr.io/hairylemon-developers/uptime-kuma:2.5.11-hairylemon-slim
docker pull ghcr.io/hairylemon-developers/uptime-kuma:2.5.11-hairylemon-kitesurf
```

`2.5.11-hairylemon-kitesurf` is the slim image with Kitesurf baked in (`BASE_IMAGE=base2-slim`, `INCLUDE_KITESURF=1`), currently published for **amd64**.
