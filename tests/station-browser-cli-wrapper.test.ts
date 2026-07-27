import { spawn } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  controlDir,
  controlSocketPath,
  controlTokenPath,
} from "../src/shared/browser-control";

const repoRoot = resolve(import.meta.dirname, "..");
const roots: string[] = [];
const servers: Server[] = [];

const newHome = async (): Promise<string> => {
  // Darwin Unix-domain paths are capped near 104 bytes; keep this fixture
  // deliberately short so the product socket suffix remains representable.
  const home = await mkdtemp("/tmp/vsb-");
  roots.push(home);
  return home;
};

const runWrapper = (
  home: string,
  args: ReadonlyArray<string>,
  stdin: string,
): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> =>
  new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      "bun",
      [join(repoRoot, "scripts/browser-cli.ts"), ...args],
      {
        cwd: repoRoot,
        env: { ...process.env, HOME: home },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectRun(new Error("station wrapper test timed out"));
    }, 8_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectRun(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolveRun({ code, stdout, stderr });
    });
    child.stdin.end(stdin);
  });

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe("fixed packaged station browser wrappers", () => {
  it("passes a signed frame only through the target host's owner-local Unix socket", async () => {
    const home = await newHome();
    await mkdir(controlDir(home), { recursive: true, mode: 0o700 });
    await writeFile(controlTokenPath(home), "transport-token\n", { mode: 0o600 });
    const responseFrame = JSON.stringify({
      version: 1,
      requestId: "request-1",
      action: "doctor",
      ok: true,
      hostId: "remote-a",
      data: { role: "remote", browserReady: true },
      error: null,
    });
    const seen: Array<{ token: string | undefined; body: unknown }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          token: request.headers["x-vellum-token"] as string | undefined,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, data: { frame: responseFrame } }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(controlSocketPath(home), resolveListen);
    });

    const result = await runWrapper(home, ["station"], '{"signed":"frame"}');
    expect(result).toEqual({
      code: 0,
      stdout: `${responseFrame}\n`,
      stderr: "",
    });
    expect(seen).toEqual([{
      token: "transport-token",
      body: { frame: '{"signed":"frame"}' },
    }]);
  });

  it("rejects arguments and oversized station input before any local execution", async () => {
    const home = await newHome();
    const extra = await runWrapper(home, ["station", "--host", "other"], "{}");
    expect(extra.code).toBe(2);
    expect(extra.stdout).toBe("");
    const oversized = await runWrapper(
      home,
      ["station"],
      "x".repeat(65 * 1024),
    );
    expect(oversized.code).toBe(1);
    expect(oversized.stdout).toBe("");
    expect(oversized.stderr).not.toContain("x".repeat(32));
  });

  it("has no standalone trust-install command", async () => {
    const home = await newHome();
    const removed = await runWrapper(home, ["station-trust"], "{}");
    expect(removed.code).toBe(2);
    expect(removed.stdout).toBe("");
    expect(removed.stderr).toContain("vellum browser control");
    expect(removed.stderr).not.toContain("station trust wrapper");
  });
});
