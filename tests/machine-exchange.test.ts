import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { Effect, Result, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { expect, it } from "vitest";
import { MachineCoreRows } from "../src/main/core-runtime";
import { startCore } from "../src/main/junto/core";
import { MachineRepository } from "../src/main/junto/machines/repository";
import { ModelRecords } from "../src/main/junto/model/records";
import { WorkService } from "../src/main/junto/work/service";
import { InstallationId } from "../src/shared/installation-id";
import { MachineExchangeData } from "../src/shared/machine-exchange";
import { MachineName } from "../src/shared/machine-control";
import { decodeOperatorResponse, encodeOperatorFrame, operatorControlSocketPath } from "../src/shared/operator-control";
import type { ExchangeFrame } from "../src/shared/work-exchange";
import { seat } from "./support/model-nodes";
import { seedCanvas } from "./support/seed-canvas";

const exchangeStatus = (home: string) => new Promise<string>((resolve, reject) => {
  const socket = createConnection(operatorControlSocketPath(home));
  let response = "";
  socket.setEncoding("utf8");
  socket.once("connect", () => socket.write(encodeOperatorFrame({
    protocol: "junto-operator/v1", id: "exchange-status", op: "machine.exchange", args: { canvas: "factory" },
  })));
  socket.on("data", chunk => { response += chunk; });
  socket.once("error", reject);
  socket.once("end", () => { socket.destroy(); resolve(response); });
});

it("reports copy and row counts through the account socket without payloads or writes", async () => {
  const home = await mkdtemp("/tmp/junto-exchange-status-");
  let core: Awaited<ReturnType<typeof startCore>> | undefined;
  try {
    core = await startCore({ home, build: "a".repeat(64), bundles: {} });
    const mini = Schema.decodeUnknownSync(InstallationId)("mini-installation");
    const bookName = Schema.decodeUnknownSync(MachineName)("book");
    const miniName = Schema.decodeUnknownSync(MachineName)("mini");
    const self = await core.runtime.runPromise(Effect.gen(function* () {
      const machines = yield* MachineRepository;
      yield* machines.configureName(bookName);
      yield* machines.pinPeer({ machineName: miniName, installationId: mini });
      return yield* machines.installationId;
    }));
    await core.runtime.runPromise(seedCanvas("factory", [
      seat("lead", { host: bookName }), seat("peer", { host: miniName }),
    ]));
    const rows = await core.runtime.runPromise(MachineCoreRows);
    const frames: ExchangeFrame[] = [];
    await core.runtime.runPromise(rows.exchange.opened({ peer: mini, send: frame => Effect.sync(() => { frames.push(frame); }) }));
    expect(frames[0]?.kind).toBe("copy");
    const appended = await core.runtime.runPromise(Effect.flatMap(WorkService, work =>
      work.workSystemMailboxNotify("factory", "peer", {
        messageId: "private-mail-id", role: "user", parts: [{ kind: "text", text: "private mail body" }],
      })));
    expect(appended.ok).toBe(true);

    const read = async () => {
      const raw = await exchangeStatus(home);
      expect(raw).not.toContain("private mail");
      expect(raw).not.toContain("private-mail-id");
      expect(raw).not.toContain("binding-peer");
      const decoded = decodeOperatorResponse(JSON.parse(raw));
      if (Result.isFailure(decoded)) throw new Error(decoded.failure.message);
      expect(decoded.success.ok).toBe(true);
      if (!decoded.success.ok) throw new Error(decoded.success.error.message);
      return Schema.decodeUnknownSync(MachineExchangeData)(decoded.success.data);
    };
    const waiting = await read();
    expect(waiting.canvases).toEqual([expect.objectContaining({
      canvasName: "factory", editor: self, editorMachine: "book",
      links: [{ machineName: "mini", installationId: mini, sent: 0, taken: 0, waiting: true }],
    })]);
    const header = await core.runtime.runPromise(Effect.flatMap(ModelRecords, records => records.getCanvas("factory")));
    await core.runtime.runPromise(rows.exchange.receive(mini, {
      kind: "have", canvases: [{ canvasName: "factory", canvasId: header!.canvas_id, writers: [] }],
    }));
    expect(frames.some(frame => frame.kind === "rows" && frame.facts.length === 1)).toBe(true);
    const totalChanges = () => core!.runtime.runPromise(Effect.flatMap(SqlClient.SqlClient, sql =>
      sql<{ count: number }>`SELECT total_changes() AS count`.pipe(Effect.map(result => result[0]!.count))));
    const before = await totalChanges();
    const sent = await read();
    expect(sent.canvases[0]?.links).toEqual([{ machineName: "mini", installationId: mini, sent: 1, taken: 0, waiting: false }]);
    expect(await totalChanges()).toBe(before);
  } finally {
    await core?.close();
    await rm(home, { recursive: true, force: true });
  }
});
