import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Result, Schema } from "effect";
import { expect, it } from "vitest";
import { startCore } from "../src/main/junto/core";
import { coreRunner } from "../src/main/core-runner";
import { ModelService } from "../src/main/junto/model/service";
import { ModelActorRefs } from "../src/main/junto/model/actor-refs";
import { WorkRepository } from "../src/main/junto/work/repository";
import { canvasReceiptBasis } from "../src/main/junto/work/delivery-receipts";
import { messageDelivery } from "../src/main/junto/work/message-delivery";
import { Command } from "../src/shared/model";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { MachinePeerIdentity } from "../src/shared/machine-control";
import { coreControlSocketPath } from "../src/main/junto/link/listener";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/junto/state/migrations";
import { decodeOperatorResponse, encodeOperatorFrame, operatorControlSocketPath } from "../src/shared/operator-control";
import { decodeWorkResponse, encodeWorkFrame, workControlDir, workControlSocketPath } from "../src/shared/work-control";

it("starts the core, answers machine.status and configures mail without a window", async () => {
  const home = await mkdtemp("/tmp/junto-core-");
  const build = "a".repeat(64);
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build, bundles: {} });
    expect(core.ready()).toBe(true);
    const listCanvases = Effect.flatMap(ModelService, model => model.listCanvases());
    expect(await coreRunner.runPromise(listCanvases)).toEqual([]);
    const raw = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(operatorControlSocketPath(home));
      let response = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(encodeOperatorFrame({
        protocol: "junto-operator/v1", id: "boot-status", op: "machine.status", args: {},
      })));
      socket.on("data", chunk => { response += chunk; });
      socket.once("error", reject);
      socket.once("end", () => { socket.destroy(); resolve(response); });
    });
    const response = decodeOperatorResponse(JSON.parse(raw));
    expect(Result.isSuccess(response)).toBe(true);
    if (Result.isFailure(response)) throw new Error(response.failure.message);
    expect(response.success).toMatchObject({
      ok: true, op: "machine.status", data: { build, juntoHome: home, pid: process.pid, ready: true },
    });
    const workPath = workControlSocketPath(workControlDir(home));
    const workReply = await new Promise<string>((resolve, reject) => {
      const socket = createConnection(workPath);
      let response = "";
      socket.setEncoding("utf8");
      socket.once("connect", () => socket.write(encodeWorkFrame({ token: "not-a-seat-credential", op: "ping" })));
      socket.on("data", chunk => {
        response += chunk;
        if (response.includes("\n")) { socket.destroy(); resolve(response); }
      });
      socket.once("error", reject);
    });
    const workResponse = decodeWorkResponse(JSON.parse(workReply));
    expect(Result.isSuccess(workResponse)).toBe(true);
    if (Result.isFailure(workResponse)) throw new Error(workResponse.failure.message);
    expect(workResponse.success).toMatchObject({ ok: false, op: "ping", error: { type: "AuthError" } });
    const database = new DatabaseSync(join(home, ".junto/state/junto.db"), { readOnly: true });
    try {
      expect(database.prepare("PRAGMA user_version").get()?.user_version).toBe(CURRENT_STATE_SCHEMA_VERSION);
      expect(database.prepare("SELECT COUNT(*) AS count FROM canvases").get()?.count).toBe(0);
    } finally { database.close(); }
    const model = await core.runtime.runPromise(ModelService);
    const machines = await core.runtime.runPromise(MachineRepository);
    await core.runtime.runPromise(machines.pinPeer(Schema.decodeUnknownSync(MachinePeerIdentity)({
      machineName: "other-mail-core", installationId: "other-mail-installation",
    })));
    const command = Schema.decodeUnknownSync(Command);
    await core.runtime.runPromise(model.command(command({ _tag: "CreateCanvas", canvas: "delivery" }), "operator"));
    await core.runtime.runPromise(model.command(command({ _tag: "Add", canvas: "delivery", nodes: [{
      kind: "agent", id: "peer-seat", x: 0, y: 0, width: 200, height: 100, z: 0,
      label: "Peer", agentKey: "local:peer", bindingId: "peer-binding", host: "other-mail-core",
      harness: "codex", overseer: false, onRemove: "detach",
    }], wires: [] }), "operator"));
    const refs = await core.runtime.runPromise(ModelActorRefs);
    const repository = await core.runtime.runPromise(WorkRepository);
    const actor = (await core.runtime.runPromise(refs.read("delivery")))[0]!;
    await core.runtime.runPromise(repository.appendMessage({
      sink: { canvasName: "delivery", nodeId: "peer-seat" },
      basis: canvasReceiptBasis({ canvasName: "delivery", seq: 1 }),
      sentBy: actor, destination: { kind: "mailbox" },
      message: { messageId: "headless-mail", role: "user", parts: [{ kind: "text", text: "hello" }] },
    }));
    // A configured core reports the real route. An unconfigured core returned
    // "waiting" before it ever looked at the destination's machine.
    expect(await messageDelivery.deliver("delivery", "peer-seat", "headless-mail")).toBe("held");
    for (const path of [operatorControlSocketPath(home), coreControlSocketPath(home), workPath]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
      expect((await lstat(dirname(path))).mode & 0o777).toBe(0o700);
    }
    await core.close();
    expect(core.ready()).toBe(false);
    await expect(coreRunner.runPromise(listCanvases)).rejects.toThrow("Junto core is not running");
    expect(existsSync(operatorControlSocketPath(home))).toBe(false);
    expect(existsSync(coreControlSocketPath(home))).toBe(false);
    expect(existsSync(workPath)).toBe(false);
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
