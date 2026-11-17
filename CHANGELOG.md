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
- **AWS Lambda regional monitor** (`aws-lambda`): run HTTP, TCP ping, or DNS checks from an Uptime Kuma–managed Lambda probe in a selected AWS Region (similar to Globalping, with Region as the location).
  - Probe function is created/updated automatically in the target Region (Node.js 26.x, arm64); credentials use the default AWS credential chain.
  - Requires `UPTIME_KUMA_AWS_LAMBDA_EXECUTION_ROLE_ARN` for first-time function create. Optional `UPTIME_KUMA_AWS_LAMBDA_FUNCTION_NAME` (default `uptime-kuma-probe`).
  - Setup warnings with CloudFormation templates to create the Lambda execution role and an IAM user (download + open Console; roles/users are not created automatically).
  - Region list follows the [AWS commercial Regions](https://docs.aws.amazon.com/global-infrastructure/latest/regions/aws-regions.html) table; Regions not enabled for the account are disabled in the UI via Account `ListRegions`.

### Environment variables (fork)

| Variable | Purpose |
| --- | --- |
| `UPTIME_KUMA_DISABLE_CHROMIUM_AUTO_DOWNLOAD` | Set to `1` to skip apt Chromium install in slim containers. |
| `UPTIME_KUMA_AWS_LAMBDA_EXECUTION_ROLE_ARN` | IAM role ARN the probe Lambda assumes (required to create the function). |
| `UPTIME_KUMA_AWS_LAMBDA_FUNCTION_NAME` | Optional probe function name (default `uptime-kuma-probe`). |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` | Optional static credentials for managing/invoking the probe (or use an instance/task role). |

See also `.env.example` and CloudFormation templates under `extra/aws-lambda-probe/`.
