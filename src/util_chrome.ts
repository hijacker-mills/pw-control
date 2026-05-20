import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function listChromeExecutableCandidates(explicitPath?: string): string[] {
  const fromEnv = process.env.PW_CONTROL_CHROME;
  const candidate = explicitPath || fromEnv;
  if (candidate) return [candidate];

  const platform = process.platform;
  if (platform === "win32") {
    return [
      `${process.env["ProgramFiles"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["ProgramFiles(x86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["LocalAppData"]}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["ProgramFiles"]}\\Chromium\\Application\\chrome.exe`,
      "chrome.exe"
    ].filter(Boolean) as string[];
  }

  if (platform === "darwin") {
    return ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "google-chrome", "chromium"];
  }

  // Linux (including WSL): try common package/snap names, then common Windows paths (if mounted).
  const linuxCandidates = [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser"
  ];

  const winMountedCandidates: string[] = [];
  try {
    const programFiles = "/mnt/c/Program Files";
    const programFilesX86 = "/mnt/c/Program Files (x86)";
    const chromePf = join(programFiles, "Google/Chrome/Application/chrome.exe");
    const chromePf86 = join(programFilesX86, "Google/Chrome/Application/chrome.exe");
    winMountedCandidates.push(chromePf, chromePf86);

    const usersDir = "/mnt/c/Users";
    if (existsSync(usersDir)) {
      for (const user of readdirSync(usersDir)) {
        const chromeUser = join(usersDir, user, "AppData/Local/Google/Chrome/Application/chrome.exe");
        winMountedCandidates.push(chromeUser);
      }
    }
  } catch {
    // Ignore; /mnt/c may not be mounted.
  }

  return [...linuxCandidates, ...winMountedCandidates];
}

export function resolveChromeExecutable(explicitPath?: string): string {
  const candidates = listChromeExecutableCandidates(explicitPath);

  // Prefer any absolute path that exists.
  for (const c of candidates) {
    if (c.startsWith("/") || c.includes(":\\")) {
      if (existsSync(c)) return c;
    }
  }

  // Fall back to a PATH-resolved name.
  return candidates[0] ?? "google-chrome";
}