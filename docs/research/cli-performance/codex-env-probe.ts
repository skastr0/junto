/**
 * Offline Codex app-server environment qualification. No model calls, existing
 * daemon, operator config, credentials, or Junto socket are used. The marker is
 * synthetic; output contains booleans only. This is command/exec evidence, not
 * proof of the TUI's forwarding to a shared daemon or model-issued tool calls.
 *
 * Run: bun docs/research/cli-performance/codex-env-probe.ts [CODEX_BINARY]
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const binary = process.argv[2] ?? "codex";
const marker = "junto-seat-" + "A".repeat(43);
const variants = [
  { name: "default", config: [] },
  { name: "automatic-secret-exclusions", config: ["shell_environment_policy.ignore_default_excludes=false"] },
  { name: "inherit-none", config: ['shell_environment_policy.inherit="none"'] },
  { name: "inherit-core", config: ['shell_environment_policy.inherit="core"'] },
  { name: "exclude-junto", config: ['shell_environment_policy.filters.JUNTO_*="exclude"'] },
  { name: "allow-junto", config: ['shell_environment_policy.filters.JUNTO_*="include"'] },
] as const;
const command = ["/bin/sh", "-c", `
  present=false; matches=false; socket=false
  if [ -n "\${JUNTO_WORK_TOKEN-}" ]; then present=true; fi
  if [ "\${JUNTO_WORK_TOKEN-}" = "${marker}" ]; then matches=true; fi
  if [ -n "\${JUNTO_WORK_SOCKET-}" ]; then socket=true; fi
  printf '{"token_present":%s,"synthetic_marker_matches":%s,"socket_present":%s}\\n' "$present" "$matches" "$socket"
`];

for (const variant of variants) {
  const root = await mkdtemp(join(tmpdir(), "junto-codex-env-"));
  await mkdir(join(root, "codex"));
  const child = spawn(binary, ["app-server", "--stdio", ...variant.config.flatMap((c) => ["-c", c])], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      CODEX_HOME: join(root, "codex"),
      JUNTO_WORK_TOKEN: marker,
      JUNTO_WORK_SOCKET: join(root, "nonexistent.sock"),
    },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const reply = JSON.parse(line);
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      if (reply.error) request.reject(new Error("Codex rejected the probe request"));
      else request.resolve(reply.result);
    } catch { /* Ignore non-protocol startup lines without printing them. */ }
  });
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", () => resolve());
  });
  let nextId = 1;
  const request = async (method: string, params: unknown) => {
    const id = nextId++;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await Promise.race([
        new Promise<unknown>((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Codex probe timeout")), 10_000);
        }),
      ]);
    } finally { clearTimeout(timer!); pending.delete(id); }
  };
  try {
    await request("initialize", {
      clientInfo: { name: "junto-env-qualification", version: "1" },
      capabilities: { experimentalApi: true, explicitGatewayOauth: true },
    });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const result = await request("command/exec", {
      command, cwd: root, timeoutMs: 5_000,
      sandboxPolicy: { type: "dangerFullAccess" },
    }) as { exitCode: number; stdout: string };
    const found = JSON.parse(result.stdout);
    console.log(JSON.stringify({
      variant: variant.name,
      success: result.exitCode === 0,
      token_present: found.token_present === true,
      synthetic_marker_matches: found.synthetic_marker_matches === true,
      socket_present: found.socket_present === true,
    }));
  } finally {
    child.stdin.end();
    await exited;
    lines.close();
    await rm(root, { recursive: true, force: true });
  }
}
