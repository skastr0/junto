/**
 * The relay leg: `junto companion-stdio --device` (the real CLI, as sshd's
 * forced command runs it) against a real owner-only operator control server
 * in a temp home. Hello, a pipelined request, and a revoked device, with the
 * app side stubbed at the operator dispatch.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companionFail, companionError, companionOk } from "../src/shared/companion-protocol";
import {
  OPERATOR_PROTOCOL_VERSION,
  type OperatorRequestEnvelope,
  type OperatorResponseEnvelope,
} from "../src/shared/operator-control";
import { startOperatorControlServer, type OperatorControlServer } from "../src/main/junto/operator-control";

const PAIRED = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const GONE = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W4";
const home = mkdtempSync(join(tmpdir(), "jr-"));
let server: OperatorControlServer;
const seen: string[] = [];

const ok = (request: OperatorRequestEnvelope, data: unknown): OperatorResponseEnvelope =>
  ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data }) as OperatorResponseEnvelope;

beforeAll(async () => {
  server = await startOperatorControlServer({
    home,
    dispatch: async (request) => {
      seen.push(request.op);
      if (request.op === "companion.hello") {
        return request.args.deviceId === PAIRED
          ? ok(request, { ok: true, hello: { appVersion: "t", deviceId: PAIRED, deviceName: "Phone", station: "Mac", serverTime: 1 } })
          : ok(request, { ok: false, error: companionError("revoked", "This phone was removed from Junto.") });
      }
      if (request.op === "companion.call") {
        const frame = request.args.request;
        return ok(request, {
          response:
            frame.op === "ping" ? companionOk(frame.id, "ping", { serverTime: 7 }) : companionFail(frame.id, companionError("not-found", "No.")),
        });
      }
      return ok(request, { ok: true, cursor: "x:0", changed: false, signals: [], reset: false });
    },
  });
});

afterAll(async () => {
  await server.close();
  rmSync(home, { recursive: true, force: true });
});

const phone = (deviceId: string, lines: ReadonlyArray<string>) =>
  new Promise<ReadonlyArray<Record<string, any>>>((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
    delete env.JUNTO_HOME;
    const child = spawn("bun", [join(process.cwd(), "src/cli/main.ts"), "companion-stdio", "--device", deviceId], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      if (out.trim().split("\n").length >= lines.length + 1) child.stdin.end();
    });
    child.on("close", () => resolve(out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))));
    for (const line of lines) child.stdin.write(`${line}\n`);
    if (lines.length === 0) child.stdin.end();
  });

const request = (id: string, op: string, args: object = {}) =>
  JSON.stringify({ v: "junto-companion/1", type: "request", id, op, args });

describe("companion-stdio relay", () => {
  it("says hello, relays requests over the operator socket, and answers each", async () => {
    const frames = await phone(PAIRED, [request("a", "ping"), request("b", "seats.list", { canvasName: "main" })]);
    expect(frames[0]).toMatchObject({ type: "event", event: "hello", data: { deviceId: PAIRED } });
    expect(frames.find((f) => f.id === "a")).toMatchObject({ ok: true, result: { serverTime: 7 } });
    expect(frames.find((f) => f.id === "b")).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(seen).toContain("companion.call");
  }, 30_000);

  it("writes one revoked frame for a removed phone and exits", async () => {
    const frames = await phone(GONE, [request("a", "ping")]);
    expect(frames).toEqual([
      { v: "junto-companion/1", type: "response", id: "", ok: false, error: { code: "revoked", message: "This phone was removed from Junto." } },
    ]);
  }, 30_000);
});
