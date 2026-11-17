const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const {
    LambdaClient,
    GetFunctionCommand,
    CreateFunctionCommand,
    UpdateFunctionCodeCommand,
    InvokeCommand,
    waitUntilFunctionActiveV2,
    waitUntilFunctionUpdatedV2,
} = require("@aws-sdk/client-lambda");
const { log } = require("../src/util");

const DEFAULT_FUNCTION_NAME = "uptime-kuma-probe";
const ZIP_PATH = path.join(__dirname, "../extra/aws-lambda-probe/function.zip");
const EXECUTION_ROLE_TEMPLATE_PATH = path.join(
    __dirname,
    "../extra/aws-lambda-probe/execution-role.cfn.yaml"
);
const IAM_USER_TEMPLATE_PATH = path.join(__dirname, "../extra/aws-lambda-probe/iam-user.cfn.yaml");
const ROLE_ENV = "UPTIME_KUMA_AWS_LAMBDA_EXECUTION_ROLE_ARN";
const NAME_ENV = "UPTIME_KUMA_AWS_LAMBDA_FUNCTION_NAME";
const EXECUTION_ROLE_TEMPLATE_URL = "/api/aws-lambda-probe/execution-role.cfn.yaml";
const IAM_USER_TEMPLATE_URL = "/api/aws-lambda-probe/iam-user.cfn.yaml";

/** @type {Map<string, { hash: string, client: import("@aws-sdk/client-lambda").LambdaClient }>} */
const regionCache = new Map();

/**
 * Manage and invoke the Uptime Kuma probe Lambda in a given AWS region.
 */
class LambdaProbeManager {
    /**
     * @param {object} [options]
     * @param {typeof LambdaClient} [options.LambdaClientClass]
     * @param {string} [options.zipPath]
     * @param {() => string|undefined} [options.getRoleArn]
     * @param {() => string} [options.getFunctionName]
     * @param {typeof waitUntilFunctionActiveV2} [options.waitUntilActive]
     * @param {typeof waitUntilFunctionUpdatedV2} [options.waitUntilUpdated]
     */
    constructor(options = {}) {
        this.LambdaClientClass = options.LambdaClientClass || LambdaClient;
        this.zipPath = options.zipPath || ZIP_PATH;
        this.getRoleArn = options.getRoleArn || (() => process.env[ROLE_ENV]);
        this.getFunctionName = options.getFunctionName || (() => process.env[NAME_ENV] || DEFAULT_FUNCTION_NAME);
        this.waitUntilActive = options.waitUntilActive || waitUntilFunctionActiveV2;
        this.waitUntilUpdated = options.waitUntilUpdated || waitUntilFunctionUpdatedV2;
        /** @type {Map<string, { hash: string, client: import("@aws-sdk/client-lambda").LambdaClient }>} */
        this.cache = options.cache || regionCache;
    }

    /**
     * Ensure the probe function exists with current code, then invoke it.
     * @param {string} region AWS region
     * @param {object} payload Probe payload
     * @returns {Promise<object>} Parsed probe result
     */
    async ensureAndInvoke(region, payload) {
        if (!region || typeof region !== "string") {
            throw new Error("AWS region (location) is required");
        }

        const client = this.getClient(region);
        await this.ensureFunction(region, client);

        const functionName = this.getFunctionName();
        log.debug("monitor", `AWS Lambda invoke ${functionName} in ${region}`);

        const response = await client.send(
            new InvokeCommand({
                FunctionName: functionName,
                InvocationType: "RequestResponse",
                LogType: "None",
                Payload: Buffer.from(JSON.stringify(payload)),
            })
        );

        if (response.FunctionError) {
            const errBody = response.Payload ? Buffer.from(response.Payload).toString("utf8") : "";
            throw new Error(`Lambda function error (${response.FunctionError}): ${errBody}`);
        }

        if (!response.Payload) {
            throw new Error("Lambda invoke returned empty payload");
        }

        const raw = Buffer.from(response.Payload).toString("utf8");
        let result;
        try {
            result = JSON.parse(raw);
        } catch {
            throw new Error(`Lambda returned invalid JSON: ${raw.slice(0, 200)}`);
        }

        return result;
    }

    /**
     * @param {string} region
     * @returns {import("@aws-sdk/client-lambda").LambdaClient}
     */
    getClient(region) {
        const cached = this.cache.get(region);
        if (cached?.client) {
            return cached.client;
        }
        const client = new this.LambdaClientClass({ region });
        this.cache.set(region, { hash: cached?.hash || "", client });
        return client;
    }

    /**
     * @returns {{ zip: Buffer, hash: string }}
     */
    readZip() {
        if (!fs.existsSync(this.zipPath)) {
            throw new Error(
                `Probe zip not found at ${this.zipPath}. Run: node extra/aws-lambda-probe/build.mjs`
            );
        }
        const zip = fs.readFileSync(this.zipPath);
        const hash = crypto.createHash("sha256").update(zip).digest("hex");
        return { zip, hash };
    }

    /**
     * Create or update the probe function if needed.
     * @param {string} region
     * @param {import("@aws-sdk/client-lambda").LambdaClient} client
     * @returns {Promise<void>}
     */
    async ensureFunction(region, client) {
        const { zip, hash } = this.readZip();
        const cached = this.cache.get(region);
        if (cached?.hash === hash) {
            return;
        }

        const functionName = this.getFunctionName();

        let exists = false;
        try {
            await client.send(new GetFunctionCommand({ FunctionName: functionName }));
            exists = true;
        } catch (e) {
            if (e.name !== "ResourceNotFoundException" && e.$metadata?.httpStatusCode !== 404) {
                throw e;
            }
        }

        if (exists) {
            log.info("monitor", `Updating AWS Lambda probe ${functionName} in ${region}`);
            await client.send(
                new UpdateFunctionCodeCommand({
                    FunctionName: functionName,
                    ZipFile: zip,
                    Architectures: ["arm64"],
                })
            );
            await this.waitUntilUpdated({ client, maxWaitTime: 120 }, { FunctionName: functionName });
        } else {
            const roleArn = this.getRoleArn();
            if (!roleArn) {
                throw new Error(
                    `Lambda function "${functionName}" does not exist in ${region}. ` +
                        `Set ${ROLE_ENV} to an IAM role ARN first. ` +
                        `Download the CloudFormation template from ${EXECUTION_ROLE_TEMPLATE_URL} ` +
                        `and create the stack in the AWS Console (Uptime Kuma will not create the role automatically).`
                );
            }

            log.info("monitor", `Creating AWS Lambda probe ${functionName} in ${region}`);
            await client.send(
                new CreateFunctionCommand({
                    FunctionName: functionName,
                    Runtime: "nodejs26.x",
                    Role: roleArn,
                    Handler: "index.handler",
                    Code: { ZipFile: zip },
                    Timeout: 30,
                    MemorySize: 128,
                    Architectures: ["arm64"],
                    Description: "Uptime Kuma regional probe (http / TCP ping / dns)",
                })
            );
            await this.waitUntilActive({ client, maxWaitTime: 120 }, { FunctionName: functionName });
        }

        this.cache.set(region, { hash, client });
    }

    /**
     * Clear region ensure cache (for tests).
     */
    clearCache() {
        this.cache.clear();
    }
}

const defaultManager = new LambdaProbeManager();

/**
 * Whether the default AWS credential chain can resolve credentials.
 * @returns {Promise<boolean>}
 */
async function hasAwsCredentials() {
    try {
        const { defaultProvider } = require("@aws-sdk/credential-provider-node");
        const creds = await defaultProvider()();
        return !!(creds && creds.accessKeyId);
    } catch {
        return false;
    }
}

/**
 * List Region codes enabled for the current AWS account (Account ListRegions API).
 * Returns null when credentials are missing or the API call fails.
 * @param {object} [options]
 * @param {typeof import("@aws-sdk/client-account").AccountClient} [options.AccountClientClass]
 * @param {() => Promise<boolean>} [options.hasCredentials]
 * @returns {Promise<string[]|null>}
 */
async function listEnabledAwsRegions(options = {}) {
    const checkCredentials = options.hasCredentials || hasAwsCredentials;
    if (!(await checkCredentials())) {
        return null;
    }

    try {
        const { AccountClient, ListRegionsCommand } = require("@aws-sdk/client-account");
        const AccountClientClass = options.AccountClientClass || AccountClient;
        // Account API is served from us-east-1 for commercial partitions.
        const client = new AccountClientClass({ region: "us-east-1" });
        const enabled = [];
        let nextToken;

        do {
            const response = await client.send(
                new ListRegionsCommand({
                    MaxResults: 50,
                    NextToken: nextToken,
                    RegionOptStatusContains: ["ENABLED", "ENABLED_BY_DEFAULT"],
                })
            );

            for (const region of response.Regions || []) {
                if (region.RegionName) {
                    enabled.push(region.RegionName);
                }
            }
            nextToken = response.NextToken;
        } while (nextToken);

        return enabled;
    } catch (e) {
        log.warn("monitor", `Failed to list enabled AWS regions: ${e.message}`);
        return null;
    }
}

/**
 * Whether UPTIME_KUMA_AWS_LAMBDA_EXECUTION_ROLE_ARN is set.
 * @returns {boolean}
 */
function hasAwsLambdaExecutionRoleArn() {
    return !!process.env[ROLE_ENV];
}

/**
 * CloudFormation console URL to create a stack from a downloaded template.
 * IAM is global; region only selects which console endpoint to open.
 * @param {string} [region]
 * @returns {string}
 */
function getCloudFormationCreateStackUrl(region = "us-east-1") {
    const safeRegion = /^[a-z0-9-]+$/.test(region) ? region : "us-east-1";
    return (
        `https://${safeRegion}.console.aws.amazon.com/cloudformation/home` +
        `?region=${encodeURIComponent(safeRegion)}#/stacks/create/template`
    );
}

module.exports = {
    LambdaProbeManager,
    defaultManager,
    hasAwsCredentials,
    hasAwsLambdaExecutionRoleArn,
    listEnabledAwsRegions,
    getCloudFormationCreateStackUrl,
    ROLE_ENV,
    NAME_ENV,
    DEFAULT_FUNCTION_NAME,
    ZIP_PATH,
    EXECUTION_ROLE_TEMPLATE_PATH,
    EXECUTION_ROLE_TEMPLATE_URL,
    IAM_USER_TEMPLATE_PATH,
    IAM_USER_TEMPLATE_URL,
};
