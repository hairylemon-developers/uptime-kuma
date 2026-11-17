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
