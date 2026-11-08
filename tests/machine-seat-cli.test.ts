import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { OPERATOR_PROTOCOL_VERSION, operatorControlSocketPath } from "../src/shared/operator-control";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const step of cleanup.splice(0)) await step(); });

/** One owner socket that answers every seat-start ok and records the args it got. */
const ownerSocket = async () => {
  const home = await mkdtemp("/tmp/junto-seat-cli-");
  const seen: unknown[] = [];
  await mkdir(join(home, ".junto", "operator"), { recursive: true, mode: 0o700 });
  const server: Server = createServer(socket => {
    let buffered = "";
    socket.on("data", chunk => {
      buffered += chunk.toString("utf8");
      const newline = buffered.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(buffered.slice(0, newline)) as { id: string; op: string; args: { canvas: string; seatId: string } };
      seen.push(request.args);
      socket.end(JSON.stringify({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true,
        data: { canvas: request.args.canvas, seatId: request.args.seatId, hostId: "mini", bindingId: "b1", status: "running" } }) + "\n");
    });
  });
  const path = operatorControlSocketPath(home);
  await new Promise<void>(resolve => server.listen(path, resolve));
  await chmod(path, 0o600);
  cleanup.push(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(home, { recursive: true, force: true }); });
  return { home, seen };
};

const run = (home: string, args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
  const environment: NodeJS.ProcessEnv = { ...process.env, JUNTO_HOME: home };
  delete environment.JUNTO_WORK_TOKEN;
  const child = spawn("bun", ["src/cli/main.ts", ...args], { env: environment });
  let stdout = "", stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  child.on("close", status => resolve({ status, stdout, stderr }));
});

it("starts a seat by canvas and seat id, and the seat decides what it starts on", async () => {
  const { home, seen } = await ownerSocket();
  const plain = await run(home, ["machine", "seat-start", "default", "seat-1"]);
  expect(plain.stderr).toBe("");
  expect(JSON.parse(plain.stdout)).toMatchObject({ ok: true, data: { status: "running" } });
  expect((await run(home, ["machine", "seat-start", "default", "seat-1", "--fresh"])).status).not.toBe(0);
  expect(seen).toEqual([{ canvas: "default", seatId: "seat-1" }]);
}, 30_000);
