#!/usr/bin/env node
/**
 * cli.ts — commander entry point.
 *
 *   agentguard scan [path]   walk + classify a project and its deps
 *   agentguard badge         print the Markdown "AgentGuard: clean" badge
 *
 * Both commands delegate: scan → scanner.scan() → report.render*(); badge →
 * report.renderBadge(). Presentation lives in report.ts (filled by a later
 * build stage); this file only wires flags to those boundaries.
 */

import { Command } from "commander";
import pc from "picocolors";
import { scan } from "./scanner.js";
import { renderReport, renderJson, renderBadge } from "./report.js";
import { VERSION } from "./version.js";

const program = new Command();

program
  .name("agentguard")
  .description(
    "Scan your dependency tree for hidden instructions aimed at your coding agent.",
  )
  .version(VERSION);

program
  .command("scan", { isDefault: true })
  .description("Scan a directory (and its dependency tree) for agent-targeted injection prose.")
  .argument("[path]", "directory to scan", ".")
  .option("--json", "emit machine-readable JSON instead of the terminal report")
  .option("--ci", "terse, log-stable output for CI pipelines")
  .option("--no-deps", "scan only the project, skip node_modules / dependencies")
  .action(async (path: string, opts: { json?: boolean; ci?: boolean; deps?: boolean }) => {
    const result = await scan(path, {
      json: opts.json,
      ci: opts.ci,
      includeDeps: opts.deps,
    });

    const out = opts.json
      ? renderJson(result)
      : renderReport(result, { ci: opts.ci ?? false });

    // Non-zero exit on HIGH so this drops into CI / pre-commit with no extra
    // wiring. We must NOT call process.exit() before the write drains: on a pipe
    // (the primary --json / CI path, not a TTY) writes are buffered and
    // process.exit() terminates the process mid-write, truncating the human
    // report at the OS pipe buffer (~128 KB) and corrupting --json into an
    // unparseable document. Setting process.exitCode and letting the event loop
    // finish flushing stdout naturally guarantees the full document survives,
    // even for multi-megabyte output that triggers backpressure.
    process.exitCode = result.exitCode;
    process.stdout.write(out + "\n");
  });

program
  .command("badge")
  .description('Print a Markdown "AgentGuard: clean" badge to paste into your README.')
  .action(() => {
    process.stdout.write(renderBadge() + "\n");
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(pc.red(`agentguard: ${message}`) + "\n");
  process.exit(2);
});
