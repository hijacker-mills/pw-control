#!/usr/bin/env node
import { run } from "./run.js";
import { parseArgv } from "./cli_args.js";

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv);
  if (parsed.kind === "help") {
    process.stdout.write(parsed.text);
    return;
  }
  const exitCode = await run(parsed);
  process.exitCode = exitCode;
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  const wantsJson =
    process.argv.includes("--json") ||
    process.argv.includes("--ai") ||
    process.env.PW_CONTROL_JSON === "1" ||
    process.env.PW_CONTROL_AI === "1";
  if (wantsJson) {
    const payload = {
      ok: false,
      action: "error",
      error: {
        message: message.startsWith("pw-control:") ? message : `pw-control: ${message}`
      }
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(message.startsWith("pw-control:") ? `${message}\n` : `pw-control: ${message}\n`);
  }
  process.exitCode = 1;
});
