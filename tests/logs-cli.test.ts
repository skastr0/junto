import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { Effect, Exit } from "effect";
import { WORK_HOME_ENV, WORK_PROTOCOL_VERSION, WORK_TOKEN_ENV, workControlSocketPath } from "../src/shared/work-control";
import { allExamples, allSchemas, commandCapabilities } from "../src/cli/core/discovery";
import { lowerLogsFlags } from "../src/cli/commands/logs";

const repoRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const runCli = (args: ReadonlyArray<string>, workHome: string) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((done, fail) => {
    const child = spawn("bun", [join(repoRoot, "src/cli/main.ts"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, [WORK_HOME_ENV]: workHome, [WORK_TOKEN_ENV]: "seat-token" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr }));
  });

const startFakeWorkSocket = async (respond: (request: Record<string, unknown>) => unknown): Promise<string> => {
  const home = await mkdtemp(join(tmpdir(), "junto-logs-cli-"));
  roots.push(home);
  const workHome = join(home, ".junto", "work");
  await mkdir(workHome, { recursive: true });
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      socket.end(`${JSON.stringify(respond(request))}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(workControlSocketPath(workHome), () => done());
  });
  return workHome;
};

describe("junto logs", () => {
  it("sends the filters as one logs.read query and prints the read", async () => {
    const read = { machine: "mini", rows: [], cut: false, unreadable: 0 };
    let observed: Record<string, unknown> | undefined;
    const workHome = await startFakeWorkSocket((request) => {
      observed = request;
      return { ok: true, op: "logs.read", protocol_version: WORK_PROTOCOL_VERSION, data: read };
    });
    const before = Date.now();
    const result = await runCli(
      ["logs", "--since", "15m", "--level", "error", "--area", "seats", "--seat", "agent-01M4G8HNHWGG9BM2YF30KMTZYZ", "--operation", "op-1", "--last", "5"],
      workHome,
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({ ok: true, command: "logs", data: read });
    expect(observed).toMatchObject({
      op: "logs.read",
      args: { level: "error", area: "seats", seat: "agent-01M4G8HNHWGG9BM2YF30KMTZYZ", operationId: "op-1", limit: 5 },
    });
    const since = (observed?.args as { since: number }).since;
    expect(since).toBeGreaterThanOrEqual(before - 15 * 60_000 - 5_000);
    expect(since).toBeLessThanOrEqual(Date.now() - 15 * 60_000 + 5_000);
  });

  it("refuses a bad filter before it reaches the socket", async () => {
    let called = false;
    const workHome = await startFakeWorkSocket(() => {
      called = true;
      return { ok: true, op: "logs.read", protocol_version: WORK_PROTOCOL_VERSION, data: {} };
    });
    const since = await runCli(["logs", "--since", "yesterday"], workHome);
    expect(since.code).toBe(1);
    const level = await runCli(["logs", "--level", "loud"], workHome);
    expect(level.code).toBe(1);
    expect(called).toBe(false);
  });

  it("reads --since as an ISO time too", async () => {
    const query = await Effect.runPromise(lowerLogsFlags({ since: "2026-10-16T10:00:00Z" }));
    expect(query).toEqual({ since: Date.parse("2026-10-16T10:00:00Z") });
    const exit = await Effect.runPromiseExit(lowerLogsFlags({ last: 0 }));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("is discoverable", () => {
    expect(allSchemas.map((schema) => schema.command_id)).toContain("logs.read");
    expect(allExamples.map((example) => example.command_id)).toContain("logs.read");
    expect(commandCapabilities.map((capability) => capability.command_id)).toContain("logs.read");
  });
});
