const { MonitorType } = require("./monitor-type");
const { chromium } = require("playwright-core");
const puppeteer = require("puppeteer-core");
const { UP, log } = require("../../src/util");
const { Settings } = require("../settings");
const childProcess = require("child_process");
const path = require("path");
const Database = require("../database");
const jwt = require("jsonwebtoken");
const config = require("../config");
const { RemoteBrowser } = require("../remote-browser");
const { commandExists } = require("../util-server");

/**
 * Cached instance of a browser (local Chromium only)
 * @type {import ("playwright-core").Browser}
 */
let browser = null;

let allowedList = [];
let lastAutoDetectChromeExecutable = null;

const DEFAULT_KITESURF_CDP_URL = "ws://127.0.0.1:8787/devtools/browser";

if (process.platform === "win32") {
    allowedList.push(process.env.LOCALAPPDATA + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Google\\Chrome\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Google\\Chrome\\Application\\chrome.exe");

    // Allow Chromium too
    allowedList.push(process.env.LOCALAPPDATA + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env.PROGRAMFILES + "\\Chromium\\Application\\chrome.exe");
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Chromium\\Application\\chrome.exe");

    // Allow MS Edge
    allowedList.push(process.env["ProgramFiles(x86)"] + "\\Microsoft\\Edge\\Application\\msedge.exe");

    // For Loop A to Z
    for (let i = 65; i <= 90; i++) {
        let drive = String.fromCharCode(i);
        allowedList.push(drive + ":\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
        allowedList.push(drive + ":\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe");
    }
} else if (process.platform === "linux") {
    allowedList = [
        "chromium",
        "chromium-browser",
        "google-chrome",

        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/usr/bin/google-chrome",
        "/snap/bin/chromium", // Ubuntu
    ];
} else if (process.platform === "darwin") {
    allowedList = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
}

/**
 * Engine for a monitor type
 * @param {string} monitorType Monitor type string
 * @returns {"chromium"|"kitesurf"} Engine name
 */
function engineForMonitorType(monitorType) {
    return monitorType === "real-browser-kitesurf" ? "kitesurf" : "chromium";
}

/**
 * Normalize remote browser engine value
 * @param {?string} engine Engine from DB
 * @returns {"chromium"|"kitesurf"} Engine name
 */
function normalizeRemoteEngine(engine) {
    return engine === "kitesurf" ? "kitesurf" : "chromium";
}

/**
 * CDP WebSocket URL for local Kitesurf
 * @returns {string} CDP URL
 */
function getKitesurfCdpUrl() {
    return process.env.UPTIME_KUMA_KITESURF_CDP_URL || DEFAULT_KITESURF_CDP_URL;
}

/**
 * Is the executable path allowed?
 * @param {string} executablePath Path to executable
 * @returns {Promise<boolean>} The executable is allowed?
 */
async function isAllowedChromeExecutable(executablePath) {
    if (config.args["allow-all-chrome-exec"] || process.env.UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC === "1") {
        return true;
    }

    // Check if the executablePath is in the list of allowed executables
    return allowedList.includes(executablePath);
}

/**
 * Get the current instance of the browser. If there isn't one, create
 * it.
 * @returns {Promise<import ("playwright-core").Browser>} The browser
 */
async function getBrowser() {
    if (browser && browser.isConnected()) {
        return browser;
    } else {
        let executablePath = await Settings.get("chromeExecutable");

        executablePath = await prepareChromeExecutable(executablePath);

        browser = await chromium.launch({
            //headless: false,
            executablePath,
        });

        return browser;
    }
}

/**
 * Connect to local Kitesurf over CDP via Puppeteer (official Kitesurf sample pattern)
 * @returns {Promise<import("puppeteer-core").Browser>} The browser
 */
async function getKitesurfBrowser() {
    const cdpUrl = getKitesurfCdpUrl();
    log.debug("kitesurf", `Connecting over CDP (puppeteer): ${cdpUrl}`);
    return puppeteer.connect({
        browserWSEndpoint: cdpUrl,
    });
}

/**
 * Connect to a configured remote browser
 * @param {integer} remoteBrowserID Remote browser ID
 * @param {integer} userId User ID
 * @param {"chromium"|"kitesurf"} expectedEngine Engine required by the monitor type
 * @returns {Promise<{browser: import("playwright-core").Browser|import("puppeteer-core").Browser, closeAfter: boolean, disconnect?: boolean}>} Connection
 */
async function getRemoteBrowser(remoteBrowserID, userId, expectedEngine) {
    let remoteBrowser = await RemoteBrowser.get(remoteBrowserID, userId);
    const engine = normalizeRemoteEngine(remoteBrowser.engine);
    if (engine !== expectedEngine) {
        throw new Error(
            `Remote browser "${remoteBrowser.name}" is type ${engine}, but this monitor requires ${expectedEngine}.`
        );
    }
    log.debug(engine, `Using remote browser: ${remoteBrowser.name} (${remoteBrowser.id})`);
    if (engine === "kitesurf") {
        return {
            browser: await puppeteer.connect({
                browserWSEndpoint: remoteBrowser.url,
            }),
            closeAfter: true,
            disconnect: true,
        };
    }
    // Playwright protocol remotes (browserless-style) reuse the shared handle
    browser = await chromium.connect(remoteBrowser.url);
    return {
        browser,
        closeAfter: false,
    };
}

/**
 * Prepare the chrome executable path
 * @param {string} executablePath Path to chrome executable
 * @returns {Promise<string>} Executable path
 */
async function prepareChromeExecutable(executablePath) {
    // Special code for using the playwright_chromium
    if (typeof executablePath === "string" && executablePath.toLocaleLowerCase() === "#playwright_chromium") {
        // Set to undefined = use playwright_chromium
        executablePath = undefined;
    } else if (!executablePath) {
        if (process.env.UPTIME_KUMA_IS_CONTAINER) {
            executablePath = "/usr/bin/chromium";
            await installChromiumViaApt(executablePath);
        } else {
            executablePath = await findChrome(allowedList);
        }
    } else {
        // User specified a path
        // Check if the executablePath is in the list of allowed
        if (!(await isAllowedChromeExecutable(executablePath))) {
            throw new Error(
                "This Chromium executable path is not allowed by default. If you are sure this is safe, please add an environment variable UPTIME_KUMA_ALLOW_ALL_CHROME_EXEC=1 to allow it."
            );
        }
    }
    return executablePath;
}

/**
 * Installs Chromium and required font packages via APT if the Chromium executable
 * is not already available.
 * @async
 * @param {string} executablePath - Path to the Chromium executable used to check
 * whether Chromium is available and to query its version after installation.
 * @returns {Promise<void>} Resolves when Chromium is successfully installed or
 * when no installation is required.
 * @throws {Error} If the APT installation fails or exits with an unexpected
 * exit code.
 */
async function installChromiumViaApt(executablePath) {
    if (await commandExists(executablePath)) {
        return;
    }
    if (process.env.UPTIME_KUMA_DISABLE_CHROMIUM_AUTO_DOWNLOAD === "1") {
        throw new Error(
            "Chromium not found. Auto-download is disabled (UPTIME_KUMA_DISABLE_CHROMIUM_AUTO_DOWNLOAD=1)."
        );
    }
    await new Promise((resolve, reject) => {
        log.info("chromium", "Installing Chromium...");
        let child = childProcess.exec(
            "apt update && apt --yes --no-install-recommends install chromium fonts-indic fonts-noto fonts-noto-cjk"
        );

        // On exit
        child.on("exit", (code) => {
            log.info("chromium", "apt install chromium exited with code " + code);

            if (code === 0) {
                log.info("chromium", "Installed Chromium");
                let version = childProcess.execSync(executablePath + " --version").toString("utf8");
                log.info("chromium", "Chromium version: " + version);
                resolve();
            } else if (code === 100) {
                reject(new Error("Installing Chromium, please wait..."));
            } else {
                reject(new Error("apt install chromium failed with code " + code));
            }
        });
    });
}

/**
 * Find the chrome executable
 * @param {string[]} executables Executables to search through
 * @returns {Promise<string>} Executable
 * @throws {Error} Could not find executable
 */
async function findChrome(executables) {
    // Use the last working executable, so we don't have to search for it again
    if (lastAutoDetectChromeExecutable) {
        if (await commandExists(lastAutoDetectChromeExecutable)) {
            return lastAutoDetectChromeExecutable;
        }
    }

    for (let executable of executables) {
        if (await commandExists(executable)) {
            lastAutoDetectChromeExecutable = executable;
            return executable;
        }
    }
    throw new Error("Chromium not found, please specify Chromium executable path in the settings page.");
}

/**
 * Reset chrome
 * @returns {Promise<void>}
 */
async function resetChrome() {
    if (browser) {
        await browser.close();
        browser = null;
    }
}

/**
 * Test if the chrome executable is valid and return the version
 * @param {string} executablePath Path to executable
 * @returns {Promise<string>} Chrome version
 */
async function testChrome(executablePath) {
    try {
        executablePath = await prepareChromeExecutable(executablePath);

        log.info("chromium", "Testing Chromium executable: " + executablePath);

        const browser = await chromium.launch({
            executablePath,
        });
        const version = browser.version();
        await browser.close();
        return version;
    } catch (e) {
        throw new Error(e.message);
    }
}

/**
 * Test local Kitesurf CDP endpoint
 * @returns {Promise<string>} Browser version string
 */
async function testKitesurf() {
    const cdpUrl = getKitesurfCdpUrl();
    log.info("kitesurf", "Testing Kitesurf CDP: " + cdpUrl);
    const ksBrowser = await puppeteer.connect({
        browserWSEndpoint: cdpUrl,
    });
    try {
        return await ksBrowser.version();
    } finally {
        await ksBrowser.disconnect();
    }
}

/**
 * @param {string} remoteBrowserURL Remote Browser URL
 * @param {"chromium"|"kitesurf"} [engine="chromium"] Remote engine type
 * @returns {Promise<boolean>} Returns if connection worked
 */
async function testRemoteBrowser(remoteBrowserURL, engine = "chromium") {
    try {
        if (normalizeRemoteEngine(engine) === "kitesurf") {
            const ksBrowser = await puppeteer.connect({
                browserWSEndpoint: remoteBrowserURL,
            });
            await ksBrowser.version();
            await ksBrowser.disconnect();
            return true;
        }
        const remote = await chromium.connect(remoteBrowserURL);
        remote.version();
        await remote.close();
        return true;
    } catch (e) {
        throw new Error(e.message);
    }
}

/**
 * Run a real-browser check via Puppeteer (Kitesurf / CDP)
 * Matches official Kitesurf sample: connect → newPage → goto → screenshot → disconnect
 * @param {object} monitor Monitor
 * @param {object} heartbeat Heartbeat
 * @param {object} server Server
 * @param {import("puppeteer-core").Browser} ksBrowser Puppeteer browser
 * @returns {Promise<void>}
 */
async function checkWithPuppeteer(monitor, heartbeat, server, ksBrowser) {
    const startedAt = Date.now();
    try {
        const page = await ksBrowser.newPage();
        // Match Playwright's default viewport (1280x720); Puppeteer defaults to 800x600
        await page.setViewport({ width: 1280, height: 720 });

        // Prevent Local File Inclusion
        // Accept only http:// and https://
        // https://github.com/louislam/uptime-kuma/security/advisories/GHSA-2qgm-m29m-cj2h
        let url = new URL(monitor.url);
        if (url.protocol !== "http:" && url.protocol !== "https:") {
            throw new Error("Invalid url protocol, only http and https are allowed.");
        }

        const timeoutMs = monitor.interval * 1000 * 0.8;
        const res = await page.goto(monitor.url, {
            timeout: timeoutMs,
        });

        if (monitor.screenshot_delay > 0) {
            await new Promise((resolve) => setTimeout(resolve, monitor.screenshot_delay));
        }

        const filename = jwt.sign(monitor.id, server.jwtSecret) + ".png";
        await page.screenshot({
            path: path.join(Database.screenshotDir, filename),
        });

        if (!res) {
            throw new Error("No response from navigation");
        }

        const status = res.status();
        if (status >= 200 && status < 400) {
            heartbeat.status = UP;
            heartbeat.msg = status;
            heartbeat.ping = Date.now() - startedAt;
        } else {
            throw new Error(status + "");
        }
    } finally {
        try {
            await ksBrowser.disconnect();
        } catch (e) {
            log.debug("kitesurf", `browser.disconnect: ${e.message}`);
        }
    }
}

class RealBrowserMonitorType extends MonitorType {
    /**
     * @param {string} name Monitor type key
     */
    constructor(name = "real-browser") {
        super();
        this.name = name;
    }

    /**
     * @inheritdoc
     */
    async check(monitor, heartbeat, server) {
        const useRemote = Boolean(monitor.remote_browser);
        const engine = engineForMonitorType(monitor.type || this.name);
        const useKitesurf = engine === "kitesurf";

        if (useKitesurf) {
            const ksBrowser = useRemote
                ? (await getRemoteBrowser(monitor.remote_browser, monitor.user_id, engine)).browser
                : await getKitesurfBrowser();
            await checkWithPuppeteer(monitor, heartbeat, server, ksBrowser);
            return;
        }

        let browserInstance;
        let closeBrowserAfter = false;

        if (useRemote) {
            const remote = await getRemoteBrowser(monitor.remote_browser, monitor.user_id, engine);
            browserInstance = remote.browser;
            closeBrowserAfter = remote.closeAfter;
        } else {
            browserInstance = await getBrowser();
        }

        const context = await browserInstance.newContext();
        const startedAt = Date.now();
        try {
            const page = await context.newPage();

            // Prevent Local File Inclusion
            // Accept only http:// and https://
            // https://github.com/louislam/uptime-kuma/security/advisories/GHSA-2qgm-m29m-cj2h
            let url = new URL(monitor.url);
            if (url.protocol !== "http:" && url.protocol !== "https:") {
                throw new Error("Invalid url protocol, only http and https are allowed.");
            }

            const timeoutMs = monitor.interval * 1000 * 0.8;
            const res = await page.goto(monitor.url, {
                waitUntil: "networkidle",
                timeout: timeoutMs,
            });

            // Wait for additional time before taking screenshot if configured
            if (monitor.screenshot_delay > 0) {
                await page.waitForTimeout(monitor.screenshot_delay);
            }

            let filename = jwt.sign(monitor.id, server.jwtSecret) + ".png";

            await page.screenshot({
                path: path.join(Database.screenshotDir, filename),
            });

            if (!res) {
                throw new Error("No response from navigation");
            }

            if (res.status() >= 200 && res.status() < 400) {
                heartbeat.status = UP;
                heartbeat.msg = res.status();

                try {
                    const timing = res.request().timing();
                    if (timing && typeof timing.responseEnd === "number" && timing.responseEnd >= 0) {
                        heartbeat.ping = timing.responseEnd;
                    } else {
                        heartbeat.ping = Date.now() - startedAt;
                    }
                } catch (e) {
                    heartbeat.ping = Date.now() - startedAt;
                }
            } else {
                throw new Error(res.status() + "");
            }
        } finally {
            await context.close();
            if (closeBrowserAfter) {
                try {
                    await browserInstance.close();
                } catch (e) {
                    log.debug("chromium", `browser.close: ${e.message}`);
                }
            }
        }
    }
}

module.exports = {
    RealBrowserMonitorType,
    testChrome,
    testKitesurf,
    resetChrome,
    testRemoteBrowser,
    engineForMonitorType,
    getKitesurfCdpUrl,
};
