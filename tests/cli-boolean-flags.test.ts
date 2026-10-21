/**
 * A boolean flag with no default makes Effect CLI answer the bare command
 * with its help instead of running it (`junto since`, `junto artifact list`).
 * Every Flag.boolean in src/cli carries Flag.withDefault, and the two bare
 * commands that once printed help reach the work socket.
 */
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WORK_HOME_ENV, WORK_PROTOCOL_VERSION, WORK_TOKEN_ENV, workControlSocketPath } from "../src/shared/work-control";

const repoRoot = resolve(import.meta.dirname, "..");

const sources = async (dir: string): Promise<ReadonlyArray<string>> =>
  (await Promise.all((await readdir(dir, { withFileTypes: true })).map((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
  }))).flat();

/** The text of `Flag.boolean(...)` and the `.pipe(...)` that follows it, if any. */
const flagExpression = (text: string, start: number): string => {
  let depth = 0;
  let index = start;
  let end = -1;
  for (; index < text.length; index++) {
    if (text[index] === "(") depth++;
    if (text[index] === ")" && --depth === 0) { end = index + 1; break; }
  }
  const pipe = text.slice(end).match(/^\s*\.pipe\(/);
  if (pipe === null) return text.slice(start, end);
  depth = 0;
  for (index = end; index < text.length; index++) {
    if (text[index] === "(") depth++;
    if (text[index] === ")" && --depth === 0) return text.slice(start, index + 1);
  }
  return text.slice(start);
};

describe("boolean flags", () => {
  it("every Flag.boolean in src/cli has a default", async () => {
    const missing: string[] = [];
    let seen = 0;
    for (const file of await sources(join(repoRoot, "src/cli"))) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(/Flag\.boolean\(/g)) {
        seen++;
        const expression = flagExpression(text, match.index);
        if (!expression.includes("Flag.withDefault(")) {
          missing.push(`${file.slice(repoRoot.length + 1)}:${text.slice(0, match.index).split("\n").length}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(missing).toEqual([]);
  });
});

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Runs one bare CLI call against a socket that answers ok, and reports the op it received. */
const bare = async (args: ReadonlyArray<string>) => {
  const home = await mkdtemp(join(tmpdir(), "junto-bare-flag-"));
  roots.push(home);
  const workHome = join(home, ".junto", "work");
  await mkdir(workHome, { recursive: true });
  let op: unknown;
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
      op = request.op;
      socket.end(`${JSON.stringify({ ok: true, op: request.op, protocol_version: WORK_PROTOCOL_VERSION, data: {} })}\n`);
    });
  });
  servers.push(server);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(workControlSocketPath(workHome), () => done());
  });
  const result = await new Promise<{ code: number | null; stdout: string }>((done, fail) => {
    const child = spawn("bun", [join(repoRoot, "src/cli/main.ts"), ...args], {
      cwd: repoRoot,
      env: { ...process.env, [WORK_HOME_ENV]: workHome, [WORK_TOKEN_ENV]: "seat-token", JUNTO_ARTIFACTS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout }));
  });
  return { ...result, op };
};

describe("bare commands run instead of printing help", () => {
  it.each([
    ["since", "since"],
    ["artifact list", "artifact.list"],
  ])("junto %s reaches the socket", async (command, op) => {
    const result = await bare(command.split(" "));
    expect(result.stdout).not.toContain("USAGE");
    expect(result.op).toBe(op);
    expect(result.code).toBe(0);
  });
});
