#!/bin/sh
set -eu

KITESURF_ROOT="${KITESURF_ROOT:-/opt/kitesurf}"
KITESURF_PORT="${KITESURF_PORT:-8787}"
KITESURF_HOST="127.0.0.1"
APP_DIR="${APP_DIR:-/app}"

start_kitesurf() {
    if [ ! -d "${KITESURF_ROOT}/packages/engine" ]; then
        echo "UPTIME_KUMA_ENABLE_KITESURF=1 but ${KITESURF_ROOT} is missing; skipping Kitesurf start." >&2
        return 0
    fi

    echo "Starting local Kitesurf on ${KITESURF_HOST}:${KITESURF_PORT}..."

    # Official local runtime uses wrangler/miniflare + workerd.
    # --expose-gc avoids V8 OOM after many navigations (upstream recommendation).
    # Run in a subshell so we do not change the entrypoint cwd (/app).
    (
        cd "${KITESURF_ROOT}/packages/engine"
        export MINIFLARE_WORKERD_V8_FLAGS="${MINIFLARE_WORKERD_V8_FLAGS:---expose-gc}"
        exec npx --prefix "${KITESURF_ROOT}" wrangler dev \
            --env local \
            -c wrangler.jsonc \
            -c test/fixtures-worker/wrangler.jsonc \
            --port "${KITESURF_PORT}" \
            --ip "${KITESURF_HOST}"
    ) >/tmp/kitesurf.log 2>&1 &
    echo $! >/tmp/kitesurf.pid

    i=0
    while [ "$i" -lt 120 ]; do
        if curl -fsS "http://${KITESURF_HOST}:${KITESURF_PORT}/json/version" >/dev/null 2>&1 \
            || curl -fsS "http://${KITESURF_HOST}:${KITESURF_PORT}/health" >/dev/null 2>&1; then
            echo "Kitesurf is ready."
            return 0
        fi
        i=$((i + 1))
        sleep 1
    done

    echo "Kitesurf failed to become ready within 120s. Last log lines:" >&2
    tail -n 80 /tmp/kitesurf.log >&2 || true
    return 1
}

if [ "${UPTIME_KUMA_ENABLE_KITESURF:-0}" = "1" ]; then
    start_kitesurf
fi

cd "${APP_DIR}"

if [ "$#" -eq 0 ]; then
    set -- node server/server.js
fi

exec "$@"
