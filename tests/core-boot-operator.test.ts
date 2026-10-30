import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { Result } from "effect";
import { expect, it } from "vitest";
import { startCore } from "../src/main/junto/core";
import { decodeOperatorResponse, encodeOperatorFrame, operatorControlSocketPath, type OperatorRequestEnvelope } from "../src/shared/operator-control";

const ask = (home: string, request: OperatorRequestEnvelope) =>
  new Promise<unknown>((resolve, reject) => {
    const socket = createConnection(operatorControlSocketPath(home));
    let response = "";
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(encodeOperatorFrame(request)));
    socket.on("data", (chunk) => { response += chunk; });
    socket.once("error", reject);
    socket.once("end", () => {
      socket.destroy();
      const decoded = decodeOperatorResponse(JSON.parse(response));
      if (Result.isFailure(decoded)) reject(new Error(decoded.failure.message));
      else resolve(decoded.success);
    });
  });

// The core starts once per process, so the desktop's operator socket is its own file.
it("opens the desktop's operator socket on demand, and keeps the launch gate and the companion's answer", async () => {
  const home = await mkdtemp("/tmp/junto-core-");
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({
      home,
      build: "d".repeat(64),
      bundles: {},
      operator: { listen: "on-demand", commands: false },
    });
    expect(existsSync(operatorControlSocketPath(home))).toBe(false);
    expect(core.ready()).toBe(true);
    await Promise.all([core.ensureOperatorListening(), core.ensureOperatorListening()]);
    expect(existsSync(operatorControlSocketPath(home))).toBe(true);
    expect(await ask(home, { protocol: "junto-operator/v1", id: "m", op: "machine.status", args: {} })).toMatchObject({
      ok: false, error: { type: "forbidden" },
    });
    expect(await ask(home, { protocol: "junto-operator/v1", id: "c", op: "companion.hello", args: { deviceId: "dev_01M65W89W7RMY723M451C6TKRJ" } })).toMatchObject({
      ok: false, error: { type: "runtime_down", message: "the phone companion is not available" },
    });
    await core.close();
    expect(existsSync(operatorControlSocketPath(home))).toBe(false);
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
