const DEFAULTS = {
    cdpUrl: "http://127.0.0.1:9222",
    cdpPort: 9222,
    launchChrome: false,
    forceLaunch: false,
    headless: false,
    noSandbox: false,
    timeoutMs: 15_000,
    json: false
};
function helpText() {
    return `pw-control: basic Playwright control over Chrome (CDP)

Usage:
  pw-control navigate <url> [options]
  pw-control eval-js "<code>" [options]
  pw-control save-cookies [--out <file>] [options]
  pw-control screenshot [--out <file>] [--full-page] [options]
  pw-control snapshot [--out <file>] [--screenshot <file>] [--full-page] [--max-text <n>] [--max-items <n>] [--include-html] [--a11y] [options]
  pw-control tabs list [options]
  pw-control tabs open <url> [options]
  pw-control tabs close [options]
  pw-control state [options]

  pw-control profiles list
  pw-control profiles path <name>
  pw-control profiles init <name>

  pw-control click <selector> [--right | --middle | --double] [--force] [--fallback-first] [--nth <index>]
  pw-control click-text <text>
  pw-control click-role <role> [--name <text>]
  pw-control hover <selector>
  pw-control type <selector> "<text>" [--delay-ms <ms>]
  pw-control press <key> [--delay-ms <ms>]
  pw-control drag <start-selector> <end-selector>
  pw-control scroll-into-view <selector>
  pw-control fill <selector> "<value>"
  pw-control fill-label <label> "<value>"
  pw-control fill-role <role> <name> "<value>"
  pw-control select <selector> <value...>
  pw-control check <selector>
  pw-control uncheck <selector>
  pw-control upload <selector> <file...>
  pw-control wait [--time-ms <ms>] [--selector <selector>] [--text <text>] [--wait-url-contains <text>] [--wait-timeout-ms <ms>]
  pw-control highlight <selector> [--duration-ms <ms>]
  pw-control resize <width> <height>

  pw-control observe console [--time-ms <ms>] [--level <log|debug|info|warning|error>]
  pw-control observe requests [--time-ms <ms>] [--filter <text>]

Options:
  --cdp-url <url>              CDP endpoint (default: ${DEFAULTS.cdpUrl})
  --cdp-port <port>            Shortcut for --cdp-url http://127.0.0.1:<port> (default: ${DEFAULTS.cdpPort})
  --launch-chrome              Launch Chrome with remote debugging (GUI unless --headless)
  --launch-gui                 Force-launch a GUI Chrome instance (skips existing CDP)
  --chrome-executable <path>   Chrome/Chromium executable path (or set PW_CONTROL_CHROME)
  --user-data-dir <path>       Chrome user data dir (profile root)
  --profile <name>             Chrome profile directory name (e.g. "Default", "Profile 1")
  --pw-profile <name>          pw-control named profile (maps to ~/.pw-control/profiles/<name>)
  --headless                   Launch Chrome headless (only used with --launch-chrome)
  --no-sandbox                 Add --no-sandbox when launching Chrome
  --timeout-ms <ms>            Action timeout (default: ${DEFAULTS.timeoutMs})
  --display <display>          X11 display to use for GUI Chrome (e.g. :0)
  --json                       Output structured JSON envelopes
  --ai                         Alias for --json (agent-friendly output)

Tab selection:
  --tab <index>                Use tab by index from 'tabs list'
  --tab-url-contains <text>    Use last tab whose URL contains text
  --url-contains <text>        Legacy alias for --tab-url-contains

Navigate options:
  --wait-until <load|domcontentloaded|networkidle>  (default: load)

Output options:
  --out <file>                 Output file (cookies.json, screenshot.png)
  --full-page                  Screenshot full page
  --screenshot <file>          Save a screenshot alongside snapshot JSON
  --max-text <n>               Snapshot text/html cap (default: 8000)
  --max-items <n>              Snapshot list cap per section (default: 200)
  --include-html               Include serialized HTML (truncated)
  --a11y                       Include accessibility snapshot in output

Click options:
  --force                      Click even if not visible
  --fallback-first             If no visible match, click first match
  --nth <index>                When selector matches multiple, choose nth match
  --no-smart                   Disable smart selector (enabled by default)
  --max-traversals <n>         Max parent levels to try (default: 3)
  --debug-selector             Show detailed selector resolution info

Smart selector (default ON): automatically tries parent elements if selector fails
  - Applies to CSS selectors; Playwright selectors (text=, role=, xpath=, >>) bypass smart

Role/text options:
  --name <text>                Accessible name for role-based actions

Wait options:
  --wait-url-contains <text>   Wait until URL contains text
  --wait-timeout-ms <ms>       Wait timeout override
`;
}
export function parseArgv(argv) {
    if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
        return { kind: "help", text: helpText() };
    }
    const command = argv[0];
    const rest = argv.slice(1);
    const { options, positionals } = parseOptions(rest);
    if (command === "navigate") {
        const url = positionals[0];
        if (!url)
            return { kind: "help", text: helpText() };
        const waitUntil = parseWaitUntil(getString(options, "--wait-until"));
        return { kind: "navigate", url, options: { ...optionsToGlobals(options), waitUntil } };
    }
    if (command === "eval-js") {
        const code = positionals[0];
        if (!code)
            return { kind: "help", text: helpText() };
        return { kind: "eval-js", code, options: optionsToGlobals(options) };
    }
    if (command === "save-cookies") {
        const outFile = getString(options, "--out") ?? "cookies.json";
        return { kind: "save-cookies", outFile, options: optionsToGlobals(options) };
    }
    if (command === "screenshot") {
        const outFile = getString(options, "--out") ?? "screenshot.png";
        const fullPage = options.has("--full-page");
        return { kind: "screenshot", outFile, fullPage, options: optionsToGlobals(options) };
    }
    if (command === "snapshot") {
        const outFile = getString(options, "--out");
        const screenshotFile = getString(options, "--screenshot");
        const fullPage = options.has("--full-page");
        const maxTextRaw = getString(options, "--max-text");
        const maxItemsRaw = getString(options, "--max-items");
        const maxText = maxTextRaw ? Number(maxTextRaw) : 8000;
        const maxItems = maxItemsRaw ? Number(maxItemsRaw) : 200;
        const includeHtml = options.has("--include-html");
        const includeA11y = options.has("--a11y");
        return {
            kind: "snapshot",
            outFile,
            screenshotFile,
            fullPage,
            maxText: Number.isFinite(maxText) && maxText > 0 ? maxText : 8000,
            maxItems: Number.isFinite(maxItems) && maxItems > 0 ? maxItems : 200,
            includeHtml,
            includeA11y,
            options: optionsToGlobals(options)
        };
    }
    if (command === "tabs") {
        const sub = positionals[0];
        if (sub === "list") {
            return { kind: "tabs-list", options: optionsToGlobals(options) };
        }
        if (sub === "open") {
            const url = positionals[1];
            if (!url)
                return { kind: "help", text: helpText() };
            const waitUntil = parseWaitUntil(getString(options, "--wait-until"));
            return { kind: "tabs-open", url, options: { ...optionsToGlobals(options), waitUntil } };
        }
        if (sub === "close") {
            return { kind: "tabs-close", options: optionsToGlobals(options) };
        }
        return { kind: "help", text: helpText() };
    }
    if (command === "state") {
        return { kind: "state", options: optionsToGlobals(options) };
    }
    if (command === "profiles") {
        const sub = positionals[0];
        if (sub === "list")
            return { kind: "profiles-list", options: optionsToGlobals(options) };
        if (sub === "path") {
            const name = positionals[1];
            if (!name)
                return { kind: "help", text: helpText() };
            return { kind: "profiles-path", name, options: optionsToGlobals(options) };
        }
        if (sub === "init") {
            const name = positionals[1];
            if (!name)
                return { kind: "help", text: helpText() };
            return { kind: "profiles-init", name, options: optionsToGlobals(options) };
        }
        return { kind: "help", text: helpText() };
    }
    if (command === "click") {
        const selector = positionals[0];
        if (!selector)
            return { kind: "help", text: helpText() };
        const button = options.has("--right") ? "right" : options.has("--middle") ? "middle" : "left";
        const clickCount = options.has("--double") ? 2 : 1;
        const force = options.has("--force");
        const fallbackFirst = options.has("--fallback-first");
        const nthRaw = getString(options, "--nth");
        const nth = nthRaw ? Number(nthRaw) : undefined;
        // Smart selector is ON by default, use --no-smart to disable
        const smartSelector = !options.has("--no-smart");
        const maxTraversalsRaw = getString(options, "--max-traversals");
        const maxTraversals = maxTraversalsRaw ? Number(maxTraversalsRaw) : undefined;
        const debugSelector = options.has("--debug-selector");
        return {
            kind: "click",
            selector,
            options: {
                ...optionsToGlobals(options),
                button,
                clickCount,
                force,
                fallbackFirst,
                nth: Number.isFinite(nth) && nth !== undefined && nth >= 0 ? nth : undefined,
                smartSelector,
                maxTraversals: Number.isFinite(maxTraversals) ? maxTraversals : undefined,
                debugSelector
            }
        };
    }
    if (command === "click-text") {
        const text = positionals[0];
        if (!text)
            return { kind: "help", text: helpText() };
        return { kind: "click-text", text, options: optionsToGlobals(options) };
    }
    if (command === "click-role") {
        const role = positionals[0];
        if (!role)
            return { kind: "help", text: helpText() };
        const name = getString(options, "--name");
        return { kind: "click-role", role, name, options: optionsToGlobals(options) };
    }
    if (command === "hover") {
        const selector = positionals[0];
        if (!selector)
            return { kind: "help", text: helpText() };
        return { kind: "hover", selector, options: optionsToGlobals(options) };
    }
    if (command === "type") {
        const selector = positionals[0];
        const text = positionals[1];
        if (!selector || text === undefined)
            return { kind: "help", text: helpText() };
        const delayRaw = getString(options, "--delay-ms");
        const delayMs = delayRaw ? Number(delayRaw) : undefined;
        return { kind: "type", selector, text, options: { ...optionsToGlobals(options), delayMs } };
    }
    if (command === "press") {
        const key = positionals[0];
        if (!key)
            return { kind: "help", text: helpText() };
        const delayRaw = getString(options, "--delay-ms");
        const delayMs = delayRaw ? Number(delayRaw) : undefined;
        return { kind: "press", key, options: { ...optionsToGlobals(options), delayMs } };
    }
    if (command === "drag") {
        const startSelector = positionals[0];
        const endSelector = positionals[1];
        if (!startSelector || !endSelector)
            return { kind: "help", text: helpText() };
        return { kind: "drag", startSelector, endSelector, options: optionsToGlobals(options) };
    }
    if (command === "scroll-into-view") {
        const selector = positionals[0];
        if (!selector)
            return { kind: "help", text: helpText() };
        return { kind: "scroll-into-view", selector, options: optionsToGlobals(options) };
    }
    if (command === "fill") {
        const selector = positionals[0];
        const value = positionals[1];
        if (!selector || value === undefined)
            return { kind: "help", text: helpText() };
        return { kind: "fill", selector, value, options: optionsToGlobals(options) };
    }
    if (command === "fill-label") {
        const label = positionals[0];
        const value = positionals[1];
        if (!label || value === undefined)
            return { kind: "help", text: helpText() };
        return { kind: "fill-label", label, value, options: optionsToGlobals(options) };
    }
    if (command === "fill-role") {
        const role = positionals[0];
        const name = positionals[1];
        const value = positionals[2];
        if (!role || !name || value === undefined)
            return { kind: "help", text: helpText() };
        return { kind: "fill-role", role, name, value, options: optionsToGlobals(options) };
    }
    if (command === "select") {
        const selector = positionals[0];
        const values = positionals.slice(1);
        if (!selector || values.length === 0)
            return { kind: "help", text: helpText() };
        return { kind: "select", selector, values, options: optionsToGlobals(options) };
    }
    if (command === "check") {
        const selector = positionals[0];
        if (!selector)
            return { kind: "help", text: helpText() };
        return { kind: "check", selector, options: optionsToGlobals(options) };
    }
    if (command === "uncheck") {
        const selector = positionals[0];
        if (!selector)
            return { kind: "help", text: helpText() };
        return { kind: "uncheck", selector, options: optionsToGlobals(options) };
    }
    if (command === "upload") {
        const selector = positionals[0];
        const files = positionals.slice(1);
        if (!selector || files.length === 0)
            return { kind: "help", text: helpText() };
        return { kind: "upload", selector, files, options: optionsToGlobals(options) };
    }
    if (command === "wait") {
        const timeRaw = getString(options, "--time-ms");
        const timeMs = timeRaw ? Number(timeRaw) : undefined;
        const selector = getString(options, "--selector");
        const text = getString(options, "--text");
        const waitUrlRaw = getString(options, "--wait-url-contains");
        const waitUrlContains = waitUrlRaw ?? (options.has("--tab-url-contains") ? undefined : getString(options, "--url-contains"));
        const waitTimeoutRaw = getString(options, "--wait-timeout-ms") ?? getString(options, "--timeout-ms");
        const waitTimeoutMs = waitTimeoutRaw ? Number(waitTimeoutRaw) : undefined;
        return {
            kind: "wait",
            options: { ...optionsToGlobals(options), timeMs, selector, text, waitUrlContains, waitTimeoutMs }
        };
    }
    if (command === "highlight") {
        const selector = positionals[0];
        if (!selector)
            return { kind: "help", text: helpText() };
        const durRaw = getString(options, "--duration-ms");
        const durationMs = durRaw ? Number(durRaw) : 1500;
        return {
            kind: "highlight",
            selector,
            options: { ...optionsToGlobals(options), durationMs: Number.isFinite(durationMs) ? durationMs : 1500 }
        };
    }
    if (command === "resize") {
        const widthRaw = positionals[0];
        const heightRaw = positionals[1];
        const width = widthRaw ? Number(widthRaw) : undefined;
        const height = heightRaw ? Number(heightRaw) : undefined;
        if (!Number.isFinite(width) || !Number.isFinite(height))
            return { kind: "help", text: helpText() };
        return { kind: "resize", width: Number(width), height: Number(height), options: optionsToGlobals(options) };
    }
    if (command === "observe") {
        const sub = positionals[0];
        if (sub === "console") {
            const timeRaw = getString(options, "--time-ms");
            const timeMs = timeRaw ? Number(timeRaw) : 5000;
            const level = getString(options, "--level");
            return {
                kind: "observe-console",
                options: { ...optionsToGlobals(options), timeMs: Number.isFinite(timeMs) ? timeMs : 5000, level }
            };
        }
        if (sub === "requests") {
            const timeRaw = getString(options, "--time-ms");
            const timeMs = timeRaw ? Number(timeRaw) : 5000;
            const filter = getString(options, "--filter");
            return {
                kind: "observe-requests",
                options: { ...optionsToGlobals(options), timeMs: Number.isFinite(timeMs) ? timeMs : 5000, filter }
            };
        }
        return { kind: "help", text: helpText() };
    }
    return { kind: "help", text: helpText() };
}
function parseWaitUntil(raw) {
    const waitUntilRaw = (raw ?? "load").toLowerCase();
    return waitUntilRaw === "domcontentloaded" || waitUntilRaw === "networkidle" || waitUntilRaw === "load"
        ? waitUntilRaw
        : "load";
}
function optionsToGlobals(map) {
    const hasExplicitCdp = map.has("--cdp-url") || map.has("--cdp-port");
    const launchGui = map.has("--launch-gui");
    const forceLaunch = (map.has("--launch-chrome") && !hasExplicitCdp) || launchGui;
    const cdpPortRaw = getString(map, "--cdp-port");
    const cdpPort = cdpPortRaw ? Number(cdpPortRaw) : DEFAULTS.cdpPort;
    const cdpUrl = String(getString(map, "--cdp-url") ?? `http://127.0.0.1:${Number.isFinite(cdpPort) ? cdpPort : 9222}`);
    const timeoutRaw = getString(map, "--timeout-ms");
    const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULTS.timeoutMs;
    const tabRaw = getString(map, "--tab");
    const tabIndex = tabRaw ? Number(tabRaw) : undefined;
    const chromeProfileDir = getString(map, "--profile");
    const display = getString(map, "--display");
    const tabUrlContains = getString(map, "--tab-url-contains") ?? getString(map, "--url-contains");
    return {
        cdpUrl,
        cdpPort: Number.isFinite(cdpPort) ? cdpPort : DEFAULTS.cdpPort,
        launchChrome: forceLaunch ? true : map.has("--launch-chrome"),
        forceLaunch,
        chromeExecutable: getString(map, "--chrome-executable"),
        userDataDir: getString(map, "--user-data-dir"),
        chromeProfileDir,
        pwProfile: getString(map, "--pw-profile"),
        headless: map.has("--headless"),
        noSandbox: map.has("--no-sandbox"),
        timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULTS.timeoutMs,
        tabIndex: Number.isFinite(tabIndex) && tabIndex !== undefined && tabIndex >= 0 ? tabIndex : undefined,
        tabUrlContains,
        display,
        json: map.has("--json") || map.has("--ai") || process.env.PW_CONTROL_JSON === "1" || process.env.PW_CONTROL_AI === "1"
    };
}
function getString(map, key) {
    const value = map.get(key);
    return typeof value === "string" ? value : undefined;
}
function parseOptions(tokens) {
    const options = new Map();
    const positionals = [];
    const requiresValue = new Set([
        "--cdp-url",
        "--cdp-port",
        "--chrome-executable",
        "--user-data-dir",
        "--profile",
        "--pw-profile",
        "--timeout-ms",
        "--wait-until",
        "--out",
        "--tab",
        "--url-contains",
        "--tab-url-contains",
        "--wait-url-contains",
        "--wait-timeout-ms",
        "--delay-ms",
        "--time-ms",
        "--selector",
        "--text",
        "--level",
        "--filter",
        "--duration-ms",
        "--nth",
        "--display",
        "--screenshot",
        "--max-text",
        "--max-items",
        "--name"
    ]);
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (!token.startsWith("--")) {
            positionals.push(token);
            continue;
        }
        const next = tokens[index + 1];
        const hasValue = Boolean(next && !next.startsWith("--"));
        if (requiresValue.has(token)) {
            if (!hasValue)
                throw new Error(`Missing value for ${token}`);
            options.set(token, next);
            index++;
            continue;
        }
        if (hasValue) {
            options.set(token, next);
            index++;
            continue;
        }
        options.set(token, true);
    }
    return { options, positionals };
}
