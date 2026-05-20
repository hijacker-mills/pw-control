# pw-control

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![License](https://img.shields.io/badge/license-UNLICENSED-lightgrey)

`pw-control` is a powerful CLI wrapper around Playwright (Chrome DevTools Protocol) for browser automation and control. It provides a simple yet flexible interface for interacting with Chrome/Chromium browsers through command-line instructions.

## Table of Contents

- [Features](#features)
- [Installation](#installation)
- [Getting Started](#getting-started)
- [Browser Profiles](#browser-profiles)
- [Tab Management](#tab-management)
- [Page Interactions](#page-interactions)
- [Observation & Monitoring](#observation--monitoring)
- [Capturing Content](#capturing-content)
- [Advanced Usage](#advanced-usage)
- [Global Options](#global-options)
- [Troubleshooting](#troubleshooting)

## Features

- **Simple CLI Interface**: Control Chrome with straightforward commands
- **Profile Management**: Create and use separate browser profiles
- **Tab Control**: Open, close, and navigate between tabs
- **DOM Interactions**: Click, type, hover, and perform other page actions
- **Form Helpers**: Checkboxes, file uploads, and label/role targeting
- **Event Monitoring**: Observe console logs and network requests
- **Content Capture**: Take screenshots and extract structured page data
- **Minimal Dependencies**: Uses only playwright-core for browser automation

## Installation

### Prerequisites

- Node.js (v14 or later)
- npm or yarn
- Chrome/Chromium browser

### Install from Source

```bash
# Clone the repository (if not already done)
git clone <repository-url>
cd pw-control

# Install dependencies
npm install

# Build the project
npm run build

# Link the CLI globally (optional)
npm link
```

## Getting Started

After installation, you can use `pw-control` to interact with Chrome:

```bash
# Navigate to a website (will launch Chrome automatically with --launch-chrome)
pw-control navigate https://example.com --launch-chrome

# Evaluate JavaScript on the page
pw-control eval-js "document.title" --launch-chrome

# Take a screenshot
pw-control screenshot --out screenshot.png --launch-chrome

# Emit structured JSON output (recommended for agents)
pw-control tabs list --json
```

## Browser Profiles

`pw-control` supports named profiles that map to Chrome's `--user-data-dir` folders, allowing you to maintain separate browsing sessions with different cookies, extensions, and settings.

### Profile Management

```bash
# List all available profiles
pw-control profiles list

# Initialize a new profile
pw-control profiles init myprofile

# Get the path to a profile
pw-control profiles path myprofile

# Use a specific profile
pw-control navigate https://example.com --launch-chrome --pw-profile myprofile
```

Profiles are stored in `~/.pw-control/profiles/<profile-name>` by default.

## Tab Management

Manage browser tabs with the following commands:

```bash
# List all open tabs
pw-control tabs list --launch-chrome

# Open a new tab with a URL
pw-control tabs open https://example.com --launch-chrome

# Close a specific tab
pw-control tabs close --tab 0

# Inspect current page and tab state
pw-control state
```

### Tab Selection

Many commands accept tab selection flags to target specific tabs:

- `--tab <index>`: Select tab by its index (0-based)
- `--tab-url-contains <text>`: Select tab by URL content

```bash
# Take a screenshot of a specific tab
pw-control screenshot --out shot.png --tab 2

# Interact with a tab containing a specific URL
pw-control click "#login-button" --tab-url-contains "account"
```

## Page Interactions

`pw-control` provides a rich set of commands for interacting with web pages using CSS selectors and accessibility targeting.

### Basic Interactions

```bash
# Click an element
pw-control click "button[type=submit]" --launch-chrome

# Right-click an element
pw-control click "#menu" --right

# Hover over an element
pw-control hover "#avatar"

# Type text into an input field
pw-control type "input[name=email]" "me@example.com"

# Press a keyboard key
pw-control press "Enter"
```

### Advanced Interactions

```bash
# Drag and drop
pw-control drag "#from" "#to"

# Scroll an element into view
pw-control scroll-into-view "#footer"

# Fill a form field
pw-control fill "input[name=q]" "playwright"

# Select an option from a dropdown
pw-control select "select#country" US

# Wait for an element or condition
pw-control wait --selector "text=Welcome" --wait-timeout-ms 30000

# Highlight an element temporarily
pw-control highlight "#main" --duration-ms 1500

# Resize the browser window
pw-control resize 1280 720
```

### Form Helpers (Recommended for Agents)

```bash
# Fill by label (accessible forms)
pw-control fill-label "Email" "user@example.com"

# Fill by role and name (e.g. textbox)
pw-control fill-role textbox "Email" "user@example.com"

# Click by visible text
pw-control click-text "Login"

# Click by role with an accessible name
pw-control click-role button --name "Submit"

# Check or uncheck boxes
pw-control check "#terms"
pw-control uncheck "#newsletter"

# Upload files
pw-control upload "#resume" files/cv.pdf
pw-control upload "#upload" files/a.pdf files/b.pdf
```

## Observation & Monitoring

Collect and monitor browser events for a specified time window:

```bash
# Monitor console logs for 5 seconds
pw-control observe console --time-ms 5000 --launch-chrome

# Filter console logs by level
pw-control observe console --time-ms 5000 --level error --launch-chrome

# Monitor network requests with URL filtering
pw-control observe requests --time-ms 5000 --filter api.example.com --launch-chrome
```

## Capturing Content

### Screenshots

```bash
# Take a screenshot of the visible area
pw-control screenshot --out shot.png --launch-chrome

# Take a full-page screenshot
pw-control screenshot --out shot.png --full-page --launch-chrome
```

### Page Snapshots

Capture structured data from a page:

```bash
# Extract page content as structured JSON
pw-control snapshot --out page-data.json --launch-chrome

# Take a snapshot with a screenshot
pw-control snapshot --screenshot shot.png --full-page --max-text 8000 --max-items 200

# Include HTML in the snapshot
pw-control snapshot --include-html --launch-chrome

# Include accessibility tree
pw-control snapshot --a11y --launch-chrome
```

Snapshots include:
- Page title and URL
- Text content
- Headings
- Links
- Buttons
- Form inputs
- Images
- Accessibility tree (optional)

## Advanced Usage

### Connecting to Existing Chrome Instance

You can connect to an already running Chrome instance with remote debugging enabled:

```bash
# Start Chrome manually with remote debugging
google-chrome --remote-debugging-port=9222 --user-data-dir=./chrome-profile --profile-directory="Default"

# Connect pw-control to the running instance
pw-control navigate https://example.com --cdp-port 9222
# or
pw-control navigate https://example.com --cdp-url http://127.0.0.1:9222
```

### GUI Example: Switch USD to Cedis on taptapsend.com

This is a tested GUI workflow for switching the receiver currency to Ghana Cedis (GHS):

```bash
# 1) Start GUI Chrome with remote debugging enabled
google-chrome \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --remote-allow-origins=* \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/pw-control-currency-gui-profile \
  about:blank

# 2) (Optional) verify CDP is reachable
curl -sS http://127.0.0.1:9222/json/version

# 3) Navigate to taptapsend
pw-control navigate https://www.taptapsend.com --cdp-port 9222 --wait-until load --json

# 4) Set destination currency to Ghana Cedis
pw-control select 'select[name="destination-currency-2"]' GH-GHS-DESTINATION --cdp-port 9222 --json

# 5) Verify selected currencies
pw-control eval-js '(() => {
  const text = document.body?.innerText || "";
  const send = text.match(/You send \([^)]+\)/)?.[0] || null;
  const recv = text.match(/They receive \([^)]+\)/)?.[0] || null;
  const origin = document.querySelector("select[name=\"origin-currency-2\"]")?.value || null;
  const destination = document.querySelector("select[name=\"destination-currency-2\"]")?.value || null;
  return { send, recv, origin, destination };
})()' --cdp-port 9222 --json
```

Expected result includes:
- `send`: `You send (USD)`
- `recv`: `They receive (GHS)`
- `origin`: `US-USD-ORIGIN`
- `destination`: `GH-GHS-DESTINATION`

### Cookie Management

```bash
# Save cookies to a file
pw-control save-cookies --out cookies.json --launch-chrome
```

## Global Options

These options can be used with most commands:

| Option | Description |
|--------|-------------|
| `--launch-chrome` | Launch a new Chrome instance automatically |
| `--headless` | Run Chrome in headless mode |
| `--cdp-port <port>` | Specify the Chrome DevTools Protocol port (default: 9222) |
| `--cdp-url <url>` | Specify the full CDP URL |
| `--pw-profile <name>` | Use a named profile |
| `--user-data-dir <path>` | Specify a custom user data directory |
| `--no-sandbox` | Add `--no-sandbox` when launching Chrome |
| `--timeout-ms <ms>` | Set operation timeout in milliseconds (default: 15000) |
| `--tab <index>` | Target a specific tab by index |
| `--tab-url-contains <text>` | Target a tab containing specific URL text |
| `--url-contains <text>` | Legacy alias for `--tab-url-contains` |
| `--json` | Emit structured JSON output |
| `--ai` | Alias for `--json` (agent-friendly output) |

You can also default to JSON output by setting `PW_CONTROL_JSON=1` or `PW_CONTROL_AI=1`.

## Troubleshooting

### Common Issues

- **Connection Errors**: Make sure Chrome is running with remote debugging enabled on the specified port
- **Element Not Found**: Check your selector or increase the timeout with `--timeout-ms`
- **Wrong Tab**: Use `pw-control tabs list` to see available tabs and target the correct one

### Debugging Tips

- To use GUI mode, omit `--headless` and launch Chrome normally (or use `--launch-chrome`)
- Try `pw-control snapshot` to get a comprehensive view of the page structure
- Increase timeouts for slow-loading pages with `--timeout-ms 30000`
