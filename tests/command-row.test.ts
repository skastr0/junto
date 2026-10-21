import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import {
  CommandQueuedResult,
  commandRowWriter,
  queueAdmits,
  rulingKeyOf,
  type RulingRefusedResult,
} from "../src/shared/command-row";
import { InstallationId } from "../src/shared/installation-id";
import { COMMAND_ROW_MAX_BYTES, QUEUE_MAX_BYTES, QUEUE_MAX_ROWS, commandKey } from "../src/shared/resource-command";
import { ExchangeFact, entitledTo, type CanvasPlacement } from "../src/shared/work-exchange";
import { OpId } from "../src/shared/work-ids";
import { WORK_PROTOCOL } from "../src/shared/work-protocol";

const id = Schema.decodeUnknownSync(InstallationId);
const editor = id("macbook");
const mini = id("mini");
const other = id("other-mini");
const timestamp = "2026-10-21T12:00:00.000Z";
const seatId = Schema.decodeUnknownSync(ActorSeatId)(`seat_${"2".repeat(64)}`);
const opId = Schema.decodeUnknownSync(OpId)("01M5ESR3G8AN1BA0AVVQC2X4WY");
const laterOpId = Schema.decodeUnknownSync(OpId)("01M5ESR3G8AN1BA0AVVQC2X4WZ");

const placement: CanvasPlacement = {
  canvasId: "canvas-factory",
  editor,
  holds: (machine) => machine === editor || machine === mini || machine === other,
  seatOf: (nodeId) => (nodeId === "peer" ? { seatId, machine: mini } : undefined),
};

const command = {
  opId,
  canvasName: "factory",
  actor: { kind: "seat", seatId, nodeId: "peer" },
  target: { kind: "task", nodeId: "board-1" },
  basis: { editor, seq: "12" },
  after: [],
  op: { kind: "start" },
};

type Item = { readonly kind: string; readonly itemId: string; readonly sink: { readonly canvasName: string; readonly nodeId: string } };

const row = <Body extends { readonly operation: string }>(writer: string, body: Body, item: Item, seq = "1") => ({
  protocol: WORK_PROTOCOL,
  id: { route: { eventHome: writer, entityHome: writer }, seq },
  recordType: "fact",
  basis: { kind: "canvas", canvasName: "factory", seq: 7 },
  item,
  operation: body.operation,
  contentSha256: "c".repeat(64),
  originAt: timestamp,
  predecessor: null,
  body,
});

const queued = (overrides: Partial<typeof command> = {}) => {
  const written = { ...command, ...overrides };
  return row(
    mini,
    { operation: "command.queued", command: written },
    { kind: "command", itemId: written.opId, sink: { canvasName: "factory", nodeId: written.target.nodeId } },
  );
};

const refused = row(
  editor,
  {
    operation: "ruling.refused",
    writer: mini,
    opId,
    actor: command.actor,
    error: { type: "InvalidTransition", message: "Task is done", details: { reason: "invalid_transition" } },
    root: opId,
  },
  { kind: "ruling", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } },
  "40",
);

const applied = row(
  editor,
  { operation: "ruling.applied", writer: mini, opId, actor: command.actor, facts: ["39"] },
  { kind: "ruling", itemId: opId, sink: { canvasName: "factory", nodeId: "board-1" } },
  "40",
);

const decodeFact = Schema.decodeUnknownResult(ExchangeFact, { onExcessProperty: "error" });
const crosses = (fact: unknown): boolean => Result.isSuccess(decodeFact(fact));
const fact = (raw: unknown): ExchangeFact => Schema.decodeUnknownSync(ExchangeFact, { onExcessProperty: "error" })(raw);

describe("command and ruling rows on the exchange", () => {
  it("admits a command row and both rulings", () => {
    expect(crosses(queued())).toBe(true);
    expect(crosses(applied)).toBe(true);
    expect(crosses(refused)).toBe(true);
  });

  it("refuses a command for another canvas, a forged item, a bare opId and a ruling that names no fact", () => {
    expect(crosses(queued({ canvasName: "private" }))).toBe(false);
    const forged = queued();
    expect(crosses({ ...forged, item: { ...forged.item, itemId: laterOpId } })).toBe(false);
    expect(crosses({ ...forged, item: { ...forged.item, sink: { canvasName: "factory", nodeId: "board-2" } } })).toBe(false);
    expect(crosses(queued({ opId: "op-1" as never }))).toBe(false);
    expect(crosses({ ...applied, body: { ...applied.body, facts: [] } })).toBe(false);
    expect(crosses({ ...refused, item: { ...refused.item, kind: "command" } })).toBe(false);
  });

  it("refuses a command or ruling that leans on another row", () => {
    const leaning = { route: { eventHome: mini, entityHome: mini }, seq: "1" };
    expect(crosses({ ...queued(), predecessor: leaning })).toBe(false);
    expect(crosses({ ...refused, predecessor: { ...leaning, route: { eventHome: editor, entityHome: editor } } })).toBe(false);
  });

  it("refuses a command row over 64 KiB", () => {
    const big = queued({ op: { kind: "replace", body: "x".repeat(COMMAND_ROW_MAX_BYTES) } as never });
    expect(crosses(big)).toBe(false);
    expect(Result.isFailure(Schema.decodeUnknownResult(CommandQueuedResult)(big.body))).toBe(true);
  });

  it("gives a command to the editing machine only, and a ruling to every machine", () => {
    const written = fact(queued());
    expect(entitledTo(editor, written, placement)).toBe(true);
    expect(entitledTo(mini, written, placement)).toBe(false);
    expect(entitledTo(other, written, placement)).toBe(false);
    for (const ruling of [fact(applied), fact(refused)]) {
      expect(entitledTo(editor, ruling, placement)).toBe(true);
      expect(entitledTo(mini, ruling, placement)).toBe(true);
      expect(entitledTo(other, ruling, placement)).toBe(true);
    }
  });

  it("says who writes each row: a seat's command its machine, everything else the editing machine", () => {
    expect(commandRowWriter(fact(queued()).body as CommandQueuedResult)).toEqual({ kind: "actor-machine" });
    const operator = queued({ actor: { kind: "operator" } as never });
    expect(commandRowWriter(fact({ ...operator, id: { route: { eventHome: editor, entityHome: editor }, seq: "1" } }).body as CommandQueuedResult)).toEqual({
      kind: "editing-machine",
    });
    expect(commandRowWriter(fact(refused).body as RulingRefusedResult)).toEqual({ kind: "editing-machine" });
  });

  it("keys a ruling by its writer and opId", () => {
    expect(rulingKeyOf(fact(refused).body as RulingRefusedResult)).toBe(commandKey(mini, opId));
  });
});

describe("the queue bound", () => {
  it("admits up to 50,000 rows and 256 MiB, and refuses past either", () => {
    expect(queueAdmits({ rows: 0, bytes: 0 }, 100)).toBe(true);
    expect(queueAdmits({ rows: QUEUE_MAX_ROWS - 1, bytes: 0 }, 100)).toBe(true);
    expect(queueAdmits({ rows: QUEUE_MAX_ROWS, bytes: 0 }, 100)).toBe(false);
    expect(queueAdmits({ rows: 1, bytes: QUEUE_MAX_BYTES - 100 }, 100)).toBe(true);
    expect(queueAdmits({ rows: 1, bytes: QUEUE_MAX_BYTES - 99 }, 100)).toBe(false);
  });
});
