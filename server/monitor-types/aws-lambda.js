const { MonitorType } = require("./monitor-type");
const { defaultManager } = require("../aws-lambda-probe-manager");
const { log, UP } = require("../../src/util");
const { evaluateJsonQuery } = require("../jsonata-sandbox");
const {
    checkStatusCode,
    getOidcTokenClientCredentials,
    encodeBase64,
    getDaysRemaining,
    checkCertExpiryNotifications,
} = require("../util-server");
const { R } = require("redbean-node");

/**
 * Regional monitoring via an Uptime Kuma-managed AWS Lambda probe.
 * Location is an AWS region (e.g. ap-southeast-2).
 * Ping subtype uses TCP connect (ICMP is unavailable in Lambda).
 */
class AwsLambdaMonitorType extends MonitorType {
    name = "aws-lambda";

    /**
     * @param {object} [options]
     * @param {import("../aws-lambda-probe-manager").LambdaProbeManager} [options.manager]
     * @param {string} [options.httpUserAgent]
     */
    constructor(options = {}) {
        super();
        this.manager = options.manager || defaultManager;
        this.httpUserAgent = options.httpUserAgent || "";
    }

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, _server) {
        if (!monitor.location) {
            throw new Error("AWS region is required");
        }

        switch (monitor.subtype) {
            case "ping":
                await this.ping(monitor, heartbeat);
                break;
            case "http":
                await this.http(monitor, heartbeat);
                break;
            case "dns":
                await this.dns(monitor, heartbeat, R);
                break;
            default:
                throw new Error(`Unsupported aws-lambda subtype: ${monitor.subtype}`);
        }
    }

    /**
     * @param {object} monitor
     * @param {object} heartbeat
     * @returns {Promise<void>}
     */
    async ping(monitor, heartbeat) {
        if (!monitor.port) {
            throw new Error("Port is required for AWS Lambda TCP ping");
        }

        const payload = {
            subtype: "ping",
            target: monitor.hostname,
            options: {
                port: monitor.port,
                timeout: Math.round((monitor.timeout || 10) * 1000),
                ipFamily: monitor.ipFamily || undefined,
            },
        };

        const result = await this.invoke(monitor.location, payload);
        if (!result.ok) {
            throw new Error(this.formatResponse(monitor.location, result.msg || "TCP ping failed"));
        }

        heartbeat.ping = result.ping ?? 0;
        heartbeat.msg = this.formatResponse(monitor.location, result.msg || "OK");
        heartbeat.status = UP;
    }

    /**
     * @param {object} monitor
     * @param {object} heartbeat
     * @returns {Promise<void>}
     */
    async http(monitor, heartbeat) {
        const url = new URL(monitor.url);
        const protocol = url.protocol.replace(":", "").toUpperCase();

        const basicAuthHeader = this.getBasicAuthHeader(monitor);
        const bearerAuthHeader = this.getBearerAuthHeader(monitor);
        const oauth2AuthHeader = await this.getOauth2AuthHeader(monitor);
        const headers = {
            ...basicAuthHeader,
            ...bearerAuthHeader,
            ...oauth2AuthHeader,
            ...(monitor.headers ? JSON.parse(monitor.headers) : {}),
        };

        if (this.httpUserAgent && !headers["User-Agent"] && !headers["user-agent"]) {
            headers["User-Agent"] = this.httpUserAgent;
        }

        if (monitor.cacheBust) {
            const cacheBust = Math.random().toString(36).substring(2);
            url.searchParams.set("uptime_kuma_cachebuster", cacheBust);
        }

        const payload = {
            subtype: "http",
            target: url.toString(),
            options: {
                method: monitor.method || "GET",
                headers,
                body: monitor.body || undefined,
                timeout: Math.round((monitor.timeout || 10) * 1000),
                collectTls: protocol === "HTTPS" && !monitor.ignoreTls,
                ipFamily: monitor.ipFamily || undefined,
            },
        };

        const result = await this.invoke(monitor.location, payload);
        if (!result.ok || !result.http) {
            throw new Error(this.formatResponse(monitor.location, result.msg || "HTTP probe failed"));
        }

        heartbeat.ping = result.ping ?? 0;

        if (!checkStatusCode(result.http.statusCode, JSON.parse(monitor.accepted_statuscodes_json))) {
            throw new Error(
                this.formatResponse(
                    monitor.location,
                    `Status code ${result.http.statusCode} not accepted. Output: ${result.msg}`
                )
            );
        }

        heartbeat.msg = this.formatResponse(
            monitor.location,
            `${result.http.statusCode} - ${result.http.statusCodeName || ""}`
        );

        const httpResult = {
            statusCode: result.http.statusCode,
            rawOutput: result.http.body || "",
        };

        if (monitor.keyword) {
            await this.handleKeywordForHTTP(monitor, heartbeat, httpResult);
            return;
        }

        if (monitor.expectedValue) {
            await this.handleJSONQueryForHTTP(monitor, heartbeat, httpResult);
            return;
        }

        await this.handleTLSInfo(monitor, protocol, result.tls);

        heartbeat.msg = this.formatResponse(monitor.location, "OK");
        heartbeat.status = UP;
    }

    /**
     * @param {object} monitor
     * @param {object} heartbeat
     * @param {object} redbean
     * @returns {Promise<void>}
     */
    async dns(monitor, heartbeat, redbean) {
        const payload = {
            subtype: "dns",
            target: monitor.hostname,
            options: {
                resolveType: monitor.dns_resolve_type || "A",
                resolver: monitor.dns_resolve_server || undefined,
                timeout: Math.round((monitor.timeout || 10) * 1000),
                ipFamily: monitor.ipFamily || undefined,
            },
        };

        const result = await this.invoke(monitor.location, payload);
        if (!result.ok) {
            throw new Error(this.formatResponse(monitor.location, result.msg || "DNS probe failed"));
        }

        const values = result.dns?.answers || [];
        let dnsMessage = values.join(" | ");
        let recordMatched = true;

        if (monitor.keyword) {
            recordMatched = this.checkDNSRecordValueMatch(monitor, values, monitor.keyword);
        }

        if (monitor.dns_last_result !== dnsMessage && dnsMessage !== undefined) {
            await redbean.exec("UPDATE `monitor` SET dns_last_result = ? WHERE id = ? ", [dnsMessage, monitor.id]);
        }

        heartbeat.ping = result.ping ?? 0;

        if (!dnsMessage) {
            dnsMessage = "No records found";
        }

        if (!recordMatched) {
            throw new Error(this.formatResponse(monitor.location, "No record matched. " + dnsMessage));
        }

        heartbeat.msg = this.formatResponse(monitor.location, dnsMessage);
        heartbeat.status = UP;
    }

    /**
     * @param {string} region
     * @param {object} payload
     * @returns {Promise<object>}
     */
    async invoke(region, payload) {
        log.debug("monitor", `AWS Lambda probe payload: ${JSON.stringify(payload)}`);
        return await this.manager.ensureAndInvoke(region, payload);
    }

    /**
     * @param {object} monitor
     * @param {string[]} values
     * @param {string} keyword
     * @returns {boolean}
     */
    checkDNSRecordValueMatch(monitor, values, keyword) {
        const regex = new RegExp(keyword, "i");
        switch (monitor.dns_resolve_type) {
            case "A":
            case "AAAA":
            case "ANY":
            case "CNAME":
            case "DNSKEY":
            case "DS":
            case "HTTPS":
            case "MX":
            case "NS":
            case "NSEC":
            case "PTR":
            case "RRSIG":
            case "SOA":
            case "SRV":
            case "SVCB":
            case "TXT":
            case "CAA":
                return values.some((record) => regex.test(record));
            default:
                return values.some((record) => regex.test(record));
        }
    }

    /**
     * @param {object} monitor
     * @param {object} heartbeat
     * @param {object} result
     * @returns {Promise<void>}
     */
    async handleKeywordForHTTP(monitor, heartbeat, result) {
        let data = result.rawOutput;
        let keywordFound = data.includes(monitor.keyword);

        if (keywordFound === Boolean(monitor.invertKeyword)) {
            data = data.replace(/<[^>]*>?|[\n\r]|\s+/gm, " ").trim();
            if (data.length > 50) {
                data = data.substring(0, 47) + "...";
            }
            throw new Error(
                heartbeat.msg + ", but keyword is " + (keywordFound ? "present" : "not") + " in [" + data + "]"
            );
        }

        heartbeat.msg += ", keyword " + (keywordFound ? "is" : "not") + " found";
        heartbeat.status = UP;
    }

    /**
     * @param {object} monitor
     * @param {object} heartbeat
     * @param {object} result
     * @returns {Promise<void>}
     */
    async handleJSONQueryForHTTP(monitor, heartbeat, result) {
        const { status, response } = await evaluateJsonQuery(
            result.rawOutput,
            monitor.jsonPath,
            monitor.jsonPathOperator,
            monitor.expectedValue
        );

        if (!status) {
            throw new Error(
                this.formatResponse(
                    monitor.location,
                    `JSON query does not pass (comparing ${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`
                )
            );
        }

        heartbeat.msg = this.formatResponse(
            monitor.location,
            `JSON query passes (comparing ${response} ${monitor.jsonPathOperator} ${monitor.expectedValue})`
        );
        heartbeat.status = UP;
    }

    /**
     * @param {object} monitor
     * @param {string} protocol
     * @param {object|null} tlsInfo
     * @returns {Promise<void>}
     */
    async handleTLSInfo(monitor, protocol, tlsInfo) {
        if (!tlsInfo) {
            return;
        }

        if (!monitor.ignoreTls && protocol === "HTTPS" && !tlsInfo.authorized) {
            throw new Error(
                this.formatResponse(monitor.location, `TLS certificate is not authorized: ${tlsInfo.error}`)
            );
        }

        let tlsInfoBean = await R.findOne("monitor_tls_info", "monitor_id = ?", [monitor.id]);

        if (tlsInfoBean == null) {
            tlsInfoBean = R.dispense("monitor_tls_info");
            tlsInfoBean.monitor_id = monitor.id;
        } else {
            try {
                let oldCertInfo = JSON.parse(tlsInfoBean.info_json);

                if (
                    oldCertInfo &&
                    oldCertInfo.certInfo &&
                    oldCertInfo.certInfo.fingerprint256 !== tlsInfo.fingerprint256
                ) {
                    log.debug("monitor", "Resetting sent_history");
                    await R.exec(
                        "DELETE FROM notification_sent_history WHERE type = 'certificate' AND monitor_id = ?",
                        [monitor.id]
                    );
                }
            } catch (e) {
                /* ignore */
            }
        }

        const validTo = new Date(tlsInfo.expiresAt);
        const certResult = {
            valid: tlsInfo.authorized,
            certInfo: {
                subject: tlsInfo.subject,
                issuer: tlsInfo.issuer,
                validTo: validTo,
                daysRemaining: getDaysRemaining(new Date(), validTo),
                fingerprint: tlsInfo.fingerprint256,
                fingerprint256: tlsInfo.fingerprint256,
                certType: "",
            },
        };

        tlsInfoBean.info_json = JSON.stringify(certResult);
        await R.store(tlsInfoBean);

        if (monitor.prometheus) {
            monitor.prometheus.update(null, certResult);
        }

        if (!monitor.ignoreTls && monitor.expiryNotification) {
            await checkCertExpiryNotifications(monitor, certResult);
        }
    }

    /**
     * @param {object} monitor
     * @returns {Promise<object>}
     */
    async getOauth2AuthHeader(monitor) {
        if (monitor.authMethod !== "oauth2-cc") {
            return {};
        }

        try {
            if (new Date((monitor.oauthAccessToken?.expires_at || 0) * 1000) <= new Date()) {
                const oAuthAccessToken = await getOidcTokenClientCredentials(
                    monitor.oauth_token_url,
                    monitor.oauth_client_id,
                    monitor.oauth_client_secret,
                    monitor.oauth_scopes,
                    monitor.oauth_audience,
                    monitor.oauth_auth_method
                );
                log.debug(
                    "monitor",
                    `[${monitor.name}] Obtained oauth access-token. Expires at ${new Date(oAuthAccessToken.expires_at * 1000)}`
                );

                monitor.oauthAccessToken = oAuthAccessToken;
            }
            return {
                Authorization: monitor.oauthAccessToken.token_type + " " + monitor.oauthAccessToken.access_token,
            };
        } catch (e) {
            throw new Error("The oauth config is invalid. " + e.message);
        }
    }

    /**
     * @param {object} monitor
     * @returns {object}
     */
    getBasicAuthHeader(monitor) {
        if (monitor.authMethod !== "basic") {
            return {};
        }

        return {
            Authorization: "Basic " + encodeBase64(monitor.basic_auth_user, monitor.basic_auth_pass),
        };
    }

    /**
     * @param {object} monitor
     * @returns {object}
     */
    getBearerAuthHeader(monitor) {
        if (monitor.authMethod !== "bearer") {
            return {};
        }

        return {
            Authorization: "Bearer " + monitor.bearer_token,
        };
    }

    /**
     * @param {string} region
     * @param {string} text
     * @returns {string}
     */
    formatResponse(region, text) {
        return `${region} : ${text}`;
    }
}

module.exports = {
    AwsLambdaMonitorType,
};
