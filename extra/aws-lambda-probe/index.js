/**
 * Uptime Kuma regional probe — zero-dependency Lambda handler (Node.js 26.x).
 * Payload: { subtype: "http"|"ping"|"dns", target: string, options: object }
 */
const net = require("node:net");
const dns = require("node:dns/promises");
const tls = require("node:tls");
const { performance } = require("node:perf_hooks");

/**
 * @param {object} event
 * @returns {Promise<object>}
 */
async function handler(event) {
    try {
        const body = typeof event === "string" ? JSON.parse(event) : event;
        const { subtype, target, options = {} } = body;

        if (!subtype || !target) {
            return fail("subtype and target are required");
        }

        switch (subtype) {
            case "http":
                return await probeHttp(target, options);
            case "ping":
                return await probeTcpPing(target, options);
            case "dns":
                return await probeDns(target, options);
            default:
                return fail(`Unknown subtype: ${subtype}`);
        }
    } catch (e) {
        return fail(e.message || String(e));
    }
}

/**
 * @param {string} msg
 * @returns {object}
 */
function fail(msg) {
    return { ok: false, ping: null, msg };
}

/**
 * TCP connect RTT (ICMP is unavailable in Lambda).
 * @param {string} hostname
 * @param {object} options
 * @returns {Promise<object>}
 */
function probeTcpPing(hostname, options) {
    const port = Number(options.port);
    if (!port || Number.isNaN(port)) {
        return Promise.resolve(fail("port is required for TCP ping"));
    }

    const timeoutMs = Number(options.timeout) || 10000;
    const family = options.ipFamily === "ipv6" ? 6 : options.ipFamily === "ipv4" ? 4 : 0;

    return new Promise((resolve) => {
        const start = performance.now();
        const socket = net.connect({ host: hostname, port, family: family || undefined });

        const done = (ok, msg) => {
            const ping = Math.round(performance.now() - start);
            try {
                socket.destroy();
            } catch {
                /* ignore */
            }
            resolve(ok ? { ok: true, ping, msg: msg || "OK" } : fail(msg || "TCP connect failed"));
        };

        socket.setTimeout(timeoutMs);
        socket.on("connect", () => done(true, "OK"));
        socket.on("timeout", () => done(false, "TCP connect timeout"));
        socket.on("error", (err) => done(false, err.message));
    });
}

/**
 * @param {string} urlString
 * @param {object} options
 * @returns {Promise<object>}
 */
async function probeHttp(urlString, options) {
    const timeoutMs = Number(options.timeout) || 10000;
    const method = options.method || "GET";
    const headers = options.headers || {};
    const body = options.body;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const start = performance.now();

    try {
        const res = await fetch(urlString, {
            method,
            headers,
            body: body || undefined,
            redirect: "follow",
            signal: controller.signal,
        });

        const text = await res.text();
        const ping = Math.round(performance.now() - start);
        const responseHeaders = Object.fromEntries(res.headers.entries());

        let tlsInfo = null;
        if (urlString.startsWith("https:") && options.collectTls) {
            tlsInfo = await collectTlsInfo(urlString, timeoutMs);
        }

        return {
            ok: true,
            ping,
            msg: `${res.status} ${res.statusText}`,
            http: {
                statusCode: res.status,
                statusCodeName: res.statusText,
                body: text,
                headers: responseHeaders,
            },
            tls: tlsInfo,
        };
    } catch (e) {
        if (e.name === "AbortError") {
            return fail("HTTP request timeout");
        }
        return fail(e.message || String(e));
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Best-effort TLS certificate info via a separate TLS connect.
 * @param {string} urlString
 * @param {number} timeoutMs
 * @returns {Promise<object|null>}
 */
function collectTlsInfo(urlString, timeoutMs) {
    let url;
    try {
        url = new URL(urlString);
    } catch {
        return Promise.resolve(null);
    }

    if (url.protocol !== "https:") {
        return Promise.resolve(null);
    }

    const port = url.port ? Number(url.port) : 443;

    return new Promise((resolve) => {
        const socket = tls.connect(
            {
                host: url.hostname,
                port,
                servername: url.hostname,
                rejectUnauthorized: false,
            },
            () => {
                const cert = socket.getPeerCertificate();
                const authorized = socket.authorized;
                const error = socket.authorizationError || null;
                socket.end();

                if (!cert || !cert.raw) {
                    resolve(null);
                    return;
                }

                resolve({
                    authorized,
                    error: error ? String(error) : null,
                    subject: cert.subject,
                    issuer: cert.issuer,
                    expiresAt: cert.valid_to,
                    fingerprint256: cert.fingerprint256,
                });
            }
        );

        socket.setTimeout(timeoutMs);
        socket.on("timeout", () => {
            socket.destroy();
            resolve(null);
        });
        socket.on("error", () => resolve(null));
    });
}

/**
 * @param {string} hostname
 * @param {object} options
 * @returns {Promise<object>}
 */
async function probeDns(hostname, options) {
    const type = (options.resolveType || "A").toUpperCase();
    const timeoutMs = Number(options.timeout) || 10000;
    const resolver = new dns.Resolver();

    if (options.resolver) {
        resolver.setServers([options.resolver.replace(/^\[|\]$/g, "")]);
    }

    const start = performance.now();

    const lookup = Promise.race([
        resolveDns(resolver, hostname, type),
        new Promise((_, reject) => setTimeout(() => reject(new Error("DNS timeout")), timeoutMs)),
    ]);

    try {
        const answers = await lookup;
        const ping = Math.round(performance.now() - start);
        return {
            ok: true,
            ping,
            msg: answers.length ? answers.join(" | ") : "No records found",
            dns: { answers },
        };
    } catch (e) {
        return fail(e.message || String(e));
    }
}

/**
 * @param {import("node:dns/promises").Resolver} resolver
 * @param {string} hostname
 * @param {string} type
 * @returns {Promise<string[]>}
 */
async function resolveDns(resolver, hostname, type) {
    switch (type) {
        case "A": {
            return await resolver.resolve4(hostname);
        }
        case "AAAA": {
            return await resolver.resolve6(hostname);
        }
        case "CNAME": {
            return await resolver.resolveCname(hostname);
        }
        case "MX": {
            const rows = await resolver.resolveMx(hostname);
            return rows.map((r) => `${r.priority} ${r.exchange}`);
        }
        case "NS": {
            return await resolver.resolveNs(hostname);
        }
        case "TXT": {
            const rows = await resolver.resolveTxt(hostname);
            return rows.map((parts) => (Array.isArray(parts) ? parts.join("") : parts));
        }
        case "SOA": {
            const r = await resolver.resolveSoa(hostname);
            return [`${r.nsname} ${r.hostmaster}`];
        }
        case "SRV": {
            const rows = await resolver.resolveSrv(hostname);
            return rows.map((r) => `${r.priority} ${r.weight} ${r.port} ${r.name}`);
        }
        case "PTR": {
            return await resolver.resolvePtr(hostname);
        }
        case "CAA": {
            const rows = await resolver.resolveCaa(hostname);
            return rows.map((r) => `${r.critical} ${r.issue || r.issuewild || r.iodef || JSON.stringify(r)}`);
        }
        case "ANY": {
            try {
                const rows = await resolver.resolveAny(hostname);
                return rows.map((r) => JSON.stringify(r));
            } catch {
                return await resolver.resolve4(hostname).catch(() => []);
            }
        }
        default: {
            const rows = await resolver.resolve(hostname, type);
            if (Array.isArray(rows)) {
                return rows.map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
            }
            return [String(rows)];
        }
    }
}

module.exports = { handler };
