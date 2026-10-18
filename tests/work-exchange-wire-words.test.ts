/**
 * A seat or terminal that stops on removal says "stop" here, and "kill-session"
 * on the wire until a later release retires the old word: a machine on an
 * older build reads only "detach" or "kill-session", and would refuse the whole
 * canvas copy. This machine reads both words, as "stop".
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

/** What a build before "stop" accepts for a seat or terminal's onRemove. */
const olderOnRemove = Schema.decodeUnknownResult(Schema.Literals(["detach", "kill-session"]));

const nodes: ReadonlyArray<Node> = [
  seat("stops", { host: "mini" as never, agentKey: "mini:claude", onRemove: "stop" }),
  seat("detaches", { host: "mini" as never, agentKey: "mini:codex", onRemove: "detach" }),
  { kind: "terminal", id: asNodeId("shell"), x: 0, y: 0, width: 100, height: 60, z: 0, host: "mini" as never, bindingId: "binding-shell" as never, onRemove: "stop" },
];

const copy = (): CanvasCopy => {
  const result = exportCanvasCopy(
    {
      canvasName: asCanvasName("factory"),
      canvasId: "canvas-factory",
      seq: 1,
      editor: EDITOR,
      nodes,
      wires: [],
      guidance: {},
      briefing: undefined,
      references: [],
      playing: true,
      seatIdOf: (node) => Schema.decodeUnknownSync(ActorSeatId)(`seat_${(node.id === "stops" ? "1" : "2").repeat(64)}`),
    },
    { installationId: MINI, machineName: "mini" },
  );
  if (!result.ok) throw new Error(result.refusal.reason);
  return result.copy;
};

/** The frame as JSON carries it to the other machine. */
const sent = (frame: ExchangeFrame) =>
  JSON.parse(JSON.stringify(encodeExchangeFrame(frame))) as {
    readonly copy: { readonly seats: ReadonlyArray<{ readonly onRemove: unknown }>; readonly terminals: ReadonlyArray<{ readonly onRemove: unknown }> };
  };

const onRemoves = (wire: ReturnType<typeof sent>) => [...wire.copy.seats, ...wire.copy.terminals].map((row) => row.onRemove);

describe("a seat's onRemove on the wire", () => {
  it("is a word an older peer's decoder accepts", () => {
    const wire = sent({ kind: "copy", copy: copy() });
    expect(onRemoves(wire).sort()).toEqual(["detach", "kill-session", "kill-session"]);
    for (const value of onRemoves(wire)) expect(Result.isSuccess(olderOnRemove(value))).toBe(true);
  });

  it("reads back as stop, from this build and from an older one", () => {
    const wire = sent({ kind: "copy", copy: copy() });
    const fromOlder = decodeExchangeFrame(wire);
    const fromNewer = decodeExchangeFrame({
      ...wire,
      copy: {
        ...wire.copy,
        seats: wire.copy.seats.map((row) => ({ ...row, onRemove: row.onRemove === "kill-session" ? "stop" : row.onRemove })),
        terminals: wire.copy.terminals.map((row) => ({ ...row, onRemove: "stop" })),
      },
    });
    for (const decoded of [fromOlder, fromNewer]) {
      if (Result.isFailure(decoded)) throw new Error(String(decoded.failure));
      expect(decoded.success).toEqual({ kind: "copy", copy: copy() });
    }
  });
});
