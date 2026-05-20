import { chromium } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { requestJson } from "./util_http.js";
import { listChromeExecutableCandidates, resolveChromeExecutable } from "./util_chrome.js";
import { ensurePwProfileDir } from "./profiles.js";
export async function connectOrLaunchChrome(options) {
    const cdpUrl = options.cdpUrl || `http://127.0.0.1:${options.cdpPort}`;
    const tryConnect = async () => chromium.connectOverCDP(cdpUrl, { timeout: safeTimeout(options.timeoutMs) });
    if (!options.forceLaunch) {
        try {
            const browser = await tryConnect();
            return { browser, cleanup: async () => browser.close().catch(() => undefined) };
        }
        catch {
            if (!options.launchChrome) {
                throw new Error(`Failed to connect to Chrome at ${cdpUrl}. Start Chrome with --remote-debugging-port=${options.cdpPort} or pass --launch-chrome.`);
            }
        }
    }
    const candidates = listChromeExecutableCandidates(options.chromeExecutable);
    const chromeExecutable = resolveChromeExecutable(options.chromeExecutable);
    // Prefer explicit user-data-dir; else use named pw-profile; else tool default.
    const userDataDir = options.userDataDir ??
        (options.pwProfile ? ensurePwProfileDir(options.pwProfile) : join(homedir(), ".pw-control", "chrome-profile"));
    await mkdir(userDataDir, { recursive: true });
    const args = [
        `--remote-debugging-port=${options.cdpPort}`,
        "--no-first-run",
        "--no-default-browser-check",
        "--remote-allow-origins=*",
        ...(options.noSandbox ? ["--no-sandbox"] : []),
        ...(options.headless ? ["--headless=new"] : []),
        `--user-data-dir=${userDataDir}`,
        ...(options.chromeProfileDir ? [`--profile-directory=${options.chromeProfileDir}`] : [])
    ];
    const env = options.display ? { ...process.env, DISPLAY: options.display } : process.env;
    await spawnDetached(chromeExecutable, args, candidates, env);
    await waitForChrome(cdpUrl, safeTimeout(options.timeoutMs));
    const browser = await tryConnect();
    return { browser, cleanup: async () => browser.close().catch(() => undefined) };
}
export async function ensureContext(browser) {
    const contexts = browser.contexts();
    return contexts.length > 0 ? contexts[0] : browser.newContext();
}
export async function ensurePage(browser, select) {
    const context = await ensureContext(browser);
    const pages = listPages(context);
    if (select?.tabIndex !== undefined) {
        const idx = select.tabIndex;
        const page = pages[idx];
        if (!page)
            throw new Error(`Tab index out of range: ${idx}`);
        return { context, page, index: idx };
    }
    if (select?.tabUrlContains) {
        const needle = select.tabUrlContains;
        const matched = pages
            .slice()
            .reverse()
            .find((p) => {
            const u = p.url();
            return u && u.includes(needle);
        });
        if (matched) {
            const idx = pages.indexOf(matched);
            return { context, page: matched, index: idx >= 0 ? idx : 0 };
        }
    }
    const preferred = pages
        .slice()
        .reverse()
        .find((p) => p.url() && p.url() !== "about:blank") ?? pages[0];
    const page = preferred ?? (await context.newPage());
    const refreshedPages = listPages(context);
    const index = Math.max(0, refreshedPages.indexOf(page));
    return { context, page, index };
}
export function listPages(context) {
    return context.pages().filter((p) => !p.isClosed());
}
async function spawnDetached(executable, args, candidates, env) {
    const child = spawn(executable, args, { detached: true, stdio: "ignore", env });
    await new Promise((resolve, reject) => {
        child.once("error", (error) => reject(error));
        child.once("spawn", () => resolve());
    }).catch((error) => {
        const anyErr = error;
        if (anyErr?.code === "ENOENT") {
            const hint = candidates
                .slice(0, 8)
                .map((c) => `  - ${c}`)
                .join("\n");
            throw new Error(`Could not start Chrome/Chromium. Executable not found: ${executable}\n` +
                `Pass --chrome-executable <path> (or set PW_CONTROL_CHROME). Tried candidates:\n${hint}`);
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to start Chrome/Chromium: ${message}`);
    });
    child.unref();
}
async function waitForChrome(cdpUrl, timeoutMs) {
    const startedAt = Date.now();
    const versionUrl = new URL("/json/version", cdpUrl).toString();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            await requestJson(versionUrl, 1_000);
            return;
        }
        catch {
            await sleep(150);
        }
    }
    throw new Error(`Timed out waiting for Chrome at ${cdpUrl}. ` +
        `If Chrome opened but CDP is unreachable, try a fresh profile: --user-data-dir ./chrome-profile`);
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function safeTimeout(timeoutMs) {
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 15_000;
}
