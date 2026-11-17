const { describe, test, mock } = require("node:test");
const assert = require("node:assert");
const { UP, PENDING } = require("../../src/util");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

describe("LambdaProbeManager", () => {
    const { LambdaProbeManager } = require("../../server/aws-lambda-probe-manager");
    const zipPath = path.join(__dirname, "../../extra/aws-lambda-probe/function.zip");

    function createMockLambdaClient() {
        const send = mock.fn();
        class MockLambdaClient {
            constructor(config) {
                this.config = config;
            }
            send(command) {
                return send(command);
            }
        }
        return { MockLambdaClient, send };
    }

    function noopWait() {
        return async () => ({});
    }

    test("creates function when missing then invokes", async () => {
        const { MockLambdaClient, send } = createMockLambdaClient();
        send.mock.mockImplementation(async (command) => {
            const name = command.constructor.name;
            if (name === "GetFunctionCommand") {
                const err = new Error("not found");
                err.name = "ResourceNotFoundException";
                throw err;
            }
            if (name === "CreateFunctionCommand") {
                return {};
            }
            if (name === "InvokeCommand") {
                return {
                    Payload: Buffer.from(JSON.stringify({ ok: true, ping: 12, msg: "OK" })),
                };
            }
            return {};
        });

        const manager = new LambdaProbeManager({
            LambdaClientClass: MockLambdaClient,
            zipPath,
            getRoleArn: () => "arn:aws:iam::123456789012:role/uptime-kuma-probe",
            getFunctionName: () => "uptime-kuma-probe-test",
            waitUntilActive: noopWait(),
            waitUntilUpdated: noopWait(),
            cache: new Map(),
        });

        const result = await manager.ensureAndInvoke("ap-southeast-2", {
            subtype: "ping",
            target: "example.com",
            options: { port: 80 },
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.ping, 12);

        const commandNames = send.mock.calls.map((c) => c.arguments[0].constructor.name);
        assert.ok(commandNames.includes("GetFunctionCommand"));
        assert.ok(commandNames.includes("CreateFunctionCommand"));
        assert.ok(commandNames.includes("InvokeCommand"));

        const createCmd = send.mock.calls.find((c) => c.arguments[0].constructor.name === "CreateFunctionCommand")
            .arguments[0];
        assert.strictEqual(createCmd.input.FunctionName, "uptime-kuma-probe-test");
        assert.strictEqual(createCmd.input.Role, "arn:aws:iam::123456789012:role/uptime-kuma-probe");
        assert.strictEqual(createCmd.input.Runtime, "nodejs26.x");
        assert.deepStrictEqual(createCmd.input.Architectures, ["arm64"]);
    });

    test("updates function code when hash changes then invokes", async () => {
        const { MockLambdaClient, send } = createMockLambdaClient();
        send.mock.mockImplementation(async (command) => {
            const name = command.constructor.name;
            if (name === "GetFunctionCommand") {
                return { Configuration: { FunctionName: "uptime-kuma-probe-test" } };
            }
            if (name === "UpdateFunctionCodeCommand") {
                return {};
            }
            if (name === "InvokeCommand") {
                return {
                    Payload: Buffer.from(JSON.stringify({ ok: true, ping: 5, msg: "OK" })),
                };
            }
            return {};
        });

        const manager = new LambdaProbeManager({
            LambdaClientClass: MockLambdaClient,
            zipPath,
            getRoleArn: () => "arn:aws:iam::123456789012:role/uptime-kuma-probe",
            getFunctionName: () => "uptime-kuma-probe-test",
            waitUntilActive: noopWait(),
            waitUntilUpdated: noopWait(),
            cache: new Map(),
        });

        const result = await manager.ensureAndInvoke("us-east-1", {
            subtype: "http",
            target: "https://example.com",
            options: {},
        });

        assert.strictEqual(result.ok, true);
        const names = send.mock.calls.map((c) => c.arguments[0].constructor.name);
        assert.ok(names.includes("UpdateFunctionCodeCommand"));
        assert.ok(names.includes("InvokeCommand"));
    });

    test("skips ensure when region hash is cached", async () => {
        const { MockLambdaClient, send } = createMockLambdaClient();
        send.mock.mockImplementation(async (command) => {
            if (command.constructor.name === "InvokeCommand") {
                return {
                    Payload: Buffer.from(JSON.stringify({ ok: true, ping: 1, msg: "OK" })),
                };
            }
            throw new Error(`Unexpected command ${command.constructor.name}`);
        });

        const zip = fs.readFileSync(zipPath);
        const hash = crypto.createHash("sha256").update(zip).digest("hex");
        const client = new MockLambdaClient({ region: "eu-west-1" });
        const cache = new Map([["eu-west-1", { hash, client }]]);

        const manager = new LambdaProbeManager({
            LambdaClientClass: MockLambdaClient,
            zipPath,
            getFunctionName: () => "uptime-kuma-probe-test",
            waitUntilActive: noopWait(),
            waitUntilUpdated: noopWait(),
            cache,
        });

        const result = await manager.ensureAndInvoke("eu-west-1", {
            subtype: "dns",
            target: "example.com",
            options: { resolveType: "A" },
        });

        assert.strictEqual(result.ok, true);
        assert.strictEqual(send.mock.calls.length, 1);
        assert.strictEqual(send.mock.calls[0].arguments[0].constructor.name, "InvokeCommand");
    });

    test("throws when create needed but role env missing", async () => {
        const { MockLambdaClient, send } = createMockLambdaClient();
        send.mock.mockImplementation(async (command) => {
            if (command.constructor.name === "GetFunctionCommand") {
                const err = new Error("not found");
                err.name = "ResourceNotFoundException";
                throw err;
            }
            return {};
        });

        const manager = new LambdaProbeManager({
            LambdaClientClass: MockLambdaClient,
            zipPath,
            getRoleArn: () => undefined,
            getFunctionName: () => "uptime-kuma-probe-test",
            waitUntilActive: noopWait(),
            waitUntilUpdated: noopWait(),
            cache: new Map(),
        });

        await assert.rejects(
            manager.ensureAndInvoke("us-west-2", { subtype: "ping", target: "x", options: { port: 80 } }),
            (error) => {
                assert.match(error.message, /UPTIME_KUMA_AWS_LAMBDA_EXECUTION_ROLE_ARN/);
                assert.match(error.message, /CloudFormation/);
                return true;
            }
        );
    });

    test("CloudFormation helper URLs and role detection", () => {
        const {
            getCloudFormationCreateStackUrl,
            hasAwsLambdaExecutionRoleArn,
            EXECUTION_ROLE_TEMPLATE_URL,
            ROLE_ENV,
        } = require("../../server/aws-lambda-probe-manager");

        assert.match(
            getCloudFormationCreateStackUrl("ap-southeast-2"),
            /ap-southeast-2\.console\.aws\.amazon\.com\/cloudformation/
        );
        assert.strictEqual(EXECUTION_ROLE_TEMPLATE_URL, "/api/aws-lambda-probe/execution-role.cfn.yaml");

        const { IAM_USER_TEMPLATE_URL, IAM_USER_TEMPLATE_PATH } = require("../../server/aws-lambda-probe-manager");
        assert.strictEqual(IAM_USER_TEMPLATE_URL, "/api/aws-lambda-probe/iam-user.cfn.yaml");
        assert.ok(require("fs").existsSync(IAM_USER_TEMPLATE_PATH));

        const previous = process.env[ROLE_ENV];
        delete process.env[ROLE_ENV];
        assert.strictEqual(hasAwsLambdaExecutionRoleArn(), false);
        process.env[ROLE_ENV] = "arn:aws:iam::123456789012:role/test";
        assert.strictEqual(hasAwsLambdaExecutionRoleArn(), true);
        if (previous === undefined) {
            delete process.env[ROLE_ENV];
        } else {
            process.env[ROLE_ENV] = previous;
        }
    });

    test("listEnabledAwsRegions returns enabled region names", async () => {
        const { listEnabledAwsRegions } = require("../../server/aws-lambda-probe-manager");
        const send = mock.fn(async () => ({
            Regions: [
                { RegionName: "us-east-1", RegionOptStatus: "ENABLED_BY_DEFAULT" },
                { RegionName: "ap-southeast-2", RegionOptStatus: "ENABLED" },
            ],
        }));

        class MockAccountClient {
            send(command) {
                return send(command);
            }
        }

        const regions = await listEnabledAwsRegions({
            AccountClientClass: MockAccountClient,
            hasCredentials: async () => true,
        });
        assert.deepStrictEqual(regions, ["us-east-1", "ap-southeast-2"]);
        assert.strictEqual(send.mock.calls.length, 1);
        assert.deepStrictEqual(send.mock.calls[0].arguments[0].input.RegionOptStatusContains, [
            "ENABLED",
            "ENABLED_BY_DEFAULT",
        ]);
    });

    test("listEnabledAwsRegions returns null without credentials", async () => {
        const { listEnabledAwsRegions } = require("../../server/aws-lambda-probe-manager");
        const regions = await listEnabledAwsRegions({
            hasCredentials: async () => false,
        });
        assert.strictEqual(regions, null);
    });

    test("throws on Lambda FunctionError", async () => {
        const { MockLambdaClient, send } = createMockLambdaClient();
        const zip = fs.readFileSync(zipPath);
        const hash = crypto.createHash("sha256").update(zip).digest("hex");
        const client = new MockLambdaClient({ region: "us-east-1" });
        const cache = new Map([["us-east-1", { hash, client }]]);

        send.mock.mockImplementation(async () => ({
            FunctionError: "Unhandled",
            Payload: Buffer.from(JSON.stringify({ errorMessage: "boom" })),
        }));

        const manager = new LambdaProbeManager({
            LambdaClientClass: MockLambdaClient,
            zipPath,
            getFunctionName: () => "uptime-kuma-probe-test",
            cache,
        });

        await assert.rejects(
            manager.ensureAndInvoke("us-east-1", { subtype: "ping", target: "x" }),
            /Lambda function error/
        );
    });
});

describe("AwsLambdaMonitorType", () => {
    const { AwsLambdaMonitorType } = require("../../server/monitor-types/aws-lambda");

    function createManagerMock(result) {
        return {
            ensureAndInvoke: mock.fn(async () => result),
        };
    }

    test("ping success sets heartbeat", async () => {
        const manager = createManagerMock({ ok: true, ping: 15, msg: "OK" });
        const monitorType = new AwsLambdaMonitorType({ manager });
        const heartbeat = { status: PENDING, msg: "", ping: 0 };
        const monitor = {
            hostname: "example.com",
            location: "ap-southeast-2",
            port: 443,
            timeout: 10,
            subtype: "ping",
        };

        await monitorType.check(monitor, heartbeat, null);

        assert.strictEqual(heartbeat.status, UP);
        assert.strictEqual(heartbeat.ping, 15);
        assert.strictEqual(heartbeat.msg, "ap-southeast-2 : OK");
        assert.deepStrictEqual(manager.ensureAndInvoke.mock.calls[0].arguments[0], "ap-southeast-2");
        assert.deepStrictEqual(manager.ensureAndInvoke.mock.calls[0].arguments[1], {
            subtype: "ping",
            target: "example.com",
            options: {
                port: 443,
                timeout: 10000,
                ipFamily: undefined,
            },
        });
    });

    test("ping requires port", async () => {
        const manager = createManagerMock({ ok: true, ping: 1, msg: "OK" });
        const monitorType = new AwsLambdaMonitorType({ manager });
        await assert.rejects(
            monitorType.check(
                { hostname: "example.com", location: "us-east-1", subtype: "ping" },
                { status: PENDING },
                null
            ),
            /Port is required/
        );
    });

    test("http success with accepted status", async () => {
        const manager = createManagerMock({
            ok: true,
            ping: 40,
            msg: "200 OK",
            http: {
                statusCode: 200,
                statusCodeName: "OK",
                body: "hello",
                headers: {},
            },
            tls: null,
        });
        const monitorType = new AwsLambdaMonitorType({ manager, httpUserAgent: "test/1.0" });
        const heartbeat = { status: PENDING, msg: "", ping: 0 };
        const monitor = {
            url: "https://example.com/path",
            location: "eu-west-1",
            subtype: "http",
            method: "GET",
            accepted_statuscodes_json: '["200-299"]',
            timeout: 10,
            headers: null,
            authMethod: null,
        };

        await monitorType.check(monitor, heartbeat, null);

        assert.strictEqual(heartbeat.status, UP);
        assert.strictEqual(heartbeat.ping, 40);
        assert.match(heartbeat.msg, /eu-west-1 : OK/);
        const payload = manager.ensureAndInvoke.mock.calls[0].arguments[1];
        assert.strictEqual(payload.subtype, "http");
        assert.strictEqual(payload.target, "https://example.com/path");
        assert.strictEqual(payload.options.headers["User-Agent"], "test/1.0");
    });

    test("http rejects unaccepted status code", async () => {
        const manager = createManagerMock({
            ok: true,
            ping: 40,
            msg: "500 Error",
            http: {
                statusCode: 500,
                statusCodeName: "Error",
                body: "fail",
                headers: {},
            },
        });
        const monitorType = new AwsLambdaMonitorType({ manager });
        await assert.rejects(
            monitorType.check(
                {
                    url: "https://example.com",
                    location: "us-east-1",
                    subtype: "http",
                    method: "GET",
                    accepted_statuscodes_json: '["200-299"]',
                    timeout: 10,
                },
                { status: PENDING, msg: "" },
                null
            ),
            /Status code 500/
        );
    });

    test("dns success updates message", async () => {
        const manager = createManagerMock({
            ok: true,
            ping: 8,
            msg: "1.2.3.4",
            dns: { answers: ["1.2.3.4"] },
        });
        const redbean = {
            exec: mock.fn(async () => {}),
        };
        const monitorType = new AwsLambdaMonitorType({ manager });
        const heartbeat = { status: PENDING, msg: "", ping: 0 };
        const monitor = {
            id: 1,
            hostname: "example.com",
            location: "us-west-2",
            subtype: "dns",
            dns_resolve_type: "A",
            timeout: 10,
        };

        await monitorType.dns(monitor, heartbeat, redbean);

        assert.strictEqual(heartbeat.status, UP);
        assert.strictEqual(heartbeat.msg, "us-west-2 : 1.2.3.4");
        assert.strictEqual(redbean.exec.mock.calls.length, 1);
    });

    test("dns keyword mismatch throws", async () => {
        const manager = createManagerMock({
            ok: true,
            ping: 8,
            msg: "9.9.9.9",
            dns: { answers: ["9.9.9.9"] },
        });
        const monitorType = new AwsLambdaMonitorType({ manager });
        await assert.rejects(
            monitorType.dns(
                {
                    id: 1,
                    hostname: "example.com",
                    location: "us-east-1",
                    subtype: "dns",
                    dns_resolve_type: "A",
                    keyword: "1\\.2\\.3\\.4",
                    timeout: 10,
                },
                { status: PENDING, msg: "" },
                { exec: async () => {} }
            ),
            /No record matched/
        );
    });

    test("requires region", async () => {
        const manager = createManagerMock({ ok: true });
        const monitorType = new AwsLambdaMonitorType({ manager });
        await assert.rejects(
            monitorType.check({ subtype: "ping", hostname: "x", port: 80 }, { status: PENDING }, null),
            /AWS region is required/
        );
    });
});
