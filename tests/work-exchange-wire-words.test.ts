/**
 * Seats and terminals have no `onRemove` any more, but a canvas copy still
 * carries one on the wire: a machine on an older build requires it, as
 * "detach" or "kill-session", and would refuse the whole copy without it.
 * This machine reads a copy with or without it, and drops it.
 */
import { Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ActorSeatId } from "../src/shared/actor-seat";
import { exportCanvasCopy, type CanvasCopy } from "../src/shared/canvas-copy";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, asNodeId, type Node } from "../src/shared/model";
import { decodeExchangeFrame, encodeExchangeFrame, type ExchangeFrame } from "../src/shared/work-exchange";
import { seat } from "./support/model-nodes";

const id = Schema.decodeUnknownSync(InstallationId);
const EDITOR = id("macbook-installation");
const MINI = id("mini-installation");

/** What a build before this one requires for a seat or terminal's onRemove. */
const olderOnRemove = Schema.decodeUnknownResult(Schema.Literals(["detach", "kill-session"]));

const nodes: ReadonlyArray<Node> = [
  seat("lead", { host: "mini" as never, agentKey: "mini:claude" }),
  { kind: "terminal", id: asNodeId("shell"), x: 0, y: 0, width: 100, height: 60, z: 0, host: "mini" as never, bindingId: "binding-shell" as never },
];

const copy = (): CanvasCopy => {
  const result = exportCanvasCopy(
    {
      automations: [],
      canvasName: asCanvasName("factory"),
      canvasId: "canvas-factory",
      seq: 1,
      editor: EDITOR,
      editorMachineName: "macbook",
      nodes,
      wires: [],
      guidance: {},
      briefing: undefined,
      references: [],
      playing: true,
      seatIdOf: () => Schema.decodeUnknownSync(ActorSeatId)(`seat_${"1".repeat(64)}`),
    },
    { installationId: MINI, machineName: "mini" },
    "cut",
  );
  if (!result.ok) throw new Error(result.refusal.reason);
  return result.copy;
};

type WireRow = Record<string, unknown>;
type WireCopy = { readonly kind: "copy"; readonly copy: { readonly seats: ReadonlyArray<WireRow>; readonly terminals: ReadonlyArray<WireRow> } };

/** The frame as JSON carries it to the other machine. */
const sent = (frame: ExchangeFrame): WireCopy => JSON.parse(JSON.stringify(encodeExchangeFrame(frame))) as WireCopy;

const withRows = (wire: WireCopy, row: (value: WireRow) => WireRow): WireCopy => ({
  ...wire,
  copy: { ...wire.copy, seats: wire.copy.seats.map(row), terminals: wire.copy.terminals.map(row) },
});

describe("a seat's onRemove on the wire", () => {
  it("is still sent, as a word an older peer's decoder accepts", () => {
    const wire = sent({ kind: "copy", copy: copy() });
    const values = [...wire.copy.seats, ...wire.copy.terminals].map((row) => row.onRemove);
    expect(values).toEqual(["detach", "detach"]);
    for (const value of values) expect(Result.isSuccess(olderOnRemove(value))).toBe(true);
  });

  it("is read and dropped from an older peer, whatever it says, and not needed from a newer one", () => {
    const wire = sent({ kind: "copy", copy: copy() });
    const fromOlder = withRows(wire, (row) => ({ ...row, onRemove: "kill-session" }));
    const fromNewer = withRows(wire, ({ onRemove: _gone, ...row }) => row);
    for (const frame of [wire, fromOlder, fromNewer]) {
      const decoded = decodeExchangeFrame(frame);
      if (Result.isFailure(decoded)) throw new Error(String(decoded.failure));
      expect(decoded.success).toEqual({ kind: "copy", copy: copy() });
    }
  });
});
