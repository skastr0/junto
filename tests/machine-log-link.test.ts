import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit } from "effect";
import type { MachineLogRead, MachineLogRow } from "../src/shared/machine-log";
import { ModelRecords } from "../src/main/junto/model/records";
import { closeMachineLog, installMachineLog, setLogMachine, writeLog } from "../src/main/junto/observability/logger";
import { fitLogRead } from "../src/main/junto/observability/log-file";
import { answerPeerLogRead, peerLogScope, receivePeerLogRead } from "../src/main/junto/observability/log-link";

const homes: string[] = [];
afterEach(() => {
  closeMachineLog();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Placed = { readonly id: string; readonly kind: "agent" | "peer" | "note"; readonly host?: string };

/** Two canvases: the mini holds a seat on "shared"; "private" is this machine's alone. */
const records = (canvases: Record<string, { readonly editor?: string; readonly nodes: ReadonlyArray<Placed> }>) =>
  ({
    listCanvases: () => Effect.succeed(Object.keys(canvases)),
    canvasEditor: (canvas: string) => Effect.succeed(canvases[canvas]?.editor),
    listNodes: (canvas: string) => Effect.succeed(canvases[canvas]?.nodes ?? []),
  }) as unknown as ModelRecords["Service"];

const world = records({
  shared: { editor: "macbook-install", nodes: [{ id: "agent-lead", kind: "agent", host: "macbook" }, { id: "agent-peer", kind: "agent", host: "mini" }] },
  private: { editor: "macbook-install", nodes: [{ id: "agent-secret", kind: "agent", host: "macbook" }] },
});
const mini = { machineName: "mini", installationId: "mini-install" };

const row = (partial: Partial<MachineLogRow>): MachineLogRow => ({
  time: "2026-10-16T10:00:00.000Z", level: "error", machine: "macbook", process: "core", source: "effect", area: "seats", message: "m",
  ...partial,
} as MachineLogRow);

describe("a linked machine's log", () => {
  it("shows a peer the canvases it holds, their seats, and rows naming neither", async () => {
    const admit = await Effect.runPromise(peerLogScope(mini).pipe(Effect.provideService(ModelRecords, world)));
    expect(admit(row({}))).toBe(true);
    expect(admit(row({ canvas: "shared" as never }))).toBe(true);
    expect(admit(row({ seat: "agent-lead" as never }))).toBe(true);
    expect(admit(row({ canvas: "private" as never }))).toBe(false);
    expect(admit(row({ seat: "agent-secret" as never }))).toBe(false);
    expect(admit(row({ failure: { tag: "SeatsFailure", message: "x", machine: "macbook", causes: [], detail: { seatId: "agent-secret" } } }))).toBe(false);
    expect(admit(row({ canvas: "shared" as never, failure: { tag: "SeatsFailure", message: "x", machine: "macbook", causes: [], detail: { seatId: "agent-secret" } } }))).toBe(false);
  });

  it("answers from this machine's log within that scope", async () => {
    const home = mkdtempSync(join(tmpdir(), "junto-log-link-"));
    homes.push(home);
    installMachineLog({ home, process: "core", echo: false });
    setLogMachine("macbook");
    writeLog({ level: "error", source: "effect", message: "shared seat failed", annotations: { canvas: "shared", seat: "agent-peer" } });
    writeLog({ level: "error", source: "effect", message: "private seat failed", annotations: { canvas: "private", seat: "agent-secret" } });
    writeLog({ level: "warn", source: "system", message: "machine row" });
    closeMachineLog();
    const read = await Effect.runPromise(answerPeerLogRead(home, mini, {}).pipe(Effect.provideService(ModelRecords, world)));
    expect(read.rows.map((entry) => entry.message)).toEqual(["shared seat failed", "machine row"]);
  });

  it("fits a read to its byte bound by dropping the oldest rows", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row({ message: `${i} ${"x".repeat(900)}` }));
    const read: MachineLogRead = { machine: "mini", rows, cut: false, unreadable: 0 };
    const fitted = fitLogRead(read, 20_000);
    expect(Buffer.byteLength(JSON.stringify(fitted))).toBeLessThanOrEqual(20_000);
    expect(fitted.cut).toBe(true);
    expect(fitted.rows.at(-1)?.message.startsWith("99 ")).toBe(true);
    expect(fitLogRead(read, 10_000_000)).toBe(read);
  });

  it("decodes a peer's answer closed, names the machine as pinned, and scrubs it again", async () => {
    const sent = {
      machine: "someone-else",
      rows: [row({
        message: "token=abcdef0123456789 refused \u001b[31mred",
        annotations: { detail: "Authorization: Bearer xyz", sessionId: "6f1c2b9e-3d4a-4f5b-8c7d-0e1f2a3b4c5d", requestId: "token=abc def" },
        failure: { tag: "SpawnRefused", message: "password: hunter2", machine: "mini", causes: [{ tag: "Error", message: "ghp_abcdefghijklmnop0123" }] },
      })],
      cut: false,
      unreadable: 0,
    };
    const read = await Effect.runPromise(receivePeerLogRead(sent, "mini"));
    expect(read.machine).toBe("mini");
    expect(read.rows[0]?.annotations?.sessionId).toBe("6f1c2b9e-3d4a-4f5b-8c7d-0e1f2a3b4c5d");
    expect(read.rows[0]?.annotations).not.toHaveProperty("requestId");
    const text = JSON.stringify(read);
    for (const secret of ["abcdef0123456789", "xyz", "hunter2", "ghp_abcdefghijklmnop0123", "\u001b"]) expect(text).not.toContain(secret);
    const refused = await Effect.runPromiseExit(receivePeerLogRead({ ...sent, rows: [{ ...sent.rows[0], extra: 1 }] }, "mini"));
    expect(Exit.isFailure(refused)).toBe(true);
    const oversized = await Effect.runPromiseExit(receivePeerLogRead({ ...sent, rows: [{ ...sent.rows[0], message: "y".repeat(5_000) }] }, "mini"));
    expect(Exit.isFailure(oversized)).toBe(true);
  });
});
