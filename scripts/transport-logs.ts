#!/usr/bin/env bun
/**
 * Read local or Remote transport journals.
 *
 *   bun scripts/transport-logs.ts local [query]
 *   bun scripts/transport-logs.ts pull <ssh-endpoint> [query]
 *
 * Query is a case-insensitive substring (station.status, host.exit, Permission denied).
 * Pull uses the product SSH kernel, not a hand-rolled ssh(1) spawn.
 */
import { readFileSync } from "node:fs";
import { Effect, ManagedRuntime } from "effect";
import {
  filterTransportLog,
  transportLogPath,
} from "../src/shared/transport-trace";
import { pullRemoteTransportLog } from "../src/main/vellum/observability/transport-pull";
import { parseSshEndpoint } from "../src/main/vellum/ssh/domain";
import { SshTransportLive } from "../src/main/vellum/ssh/live";

const usage = (): never => {
  process.stderr.write(
    "usage: bun scripts/transport-logs.ts local|pull [ssh-endpoint] [query]\n",
  );
  process.exit(2);
};

const [mode, second, third] = process.argv.slice(2);
if (mode !== "local" && mode !== "pull") usage();

if (mode === "local") {
  const query = second;
  try {
    const text = readFileSync(transportLogPath(), "utf8");
    const out = filterTransportLog(text, query);
    process.stdout.write(out.endsWith("\n") ? out : `${out}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${transportLogPath()}: ${message}\n`);
    process.exit(1);
  }
  process.exit(0);
}

if (second === undefined || second.length === 0) usage();
const query = third;
const target = await Effect.runPromise(parseSshEndpoint(second));
const runtime = ManagedRuntime.make(SshTransportLive);
try {
  const pulled = await runtime.runPromise(pullRemoteTransportLog(target));
  const out = filterTransportLog(pulled.text, query);
  process.stdout.write(
    `# ${pulled.endpoint} ${pulled.path}\n${out.endsWith("\n") ? out : `${out}\n`}`,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`pull failed: ${message}\n`);
  process.exit(1);
} finally {
  await runtime.dispose();
}
