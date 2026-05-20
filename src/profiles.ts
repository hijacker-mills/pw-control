import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function profilesRootDir(): string {
  return join(homedir(), ".pw-control", "profiles");
}

export function resolvePwProfileDir(profileName: string): string {
  return join(profilesRootDir(), profileName);
}

export function ensurePwProfileDir(profileName: string): string {
  const dir = resolvePwProfileDir(profileName);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function listPwProfiles(): string[] {
  const root = profilesRootDir();
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}