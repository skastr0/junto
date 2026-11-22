/**
 * The scene's current state as ops (#912): what a late subscriber (the
 * magnifier's lens) is seeded from instead of a capped replay buffer. Every
 * op folds into the state it leaves behind, so the snapshot is the size of
 * the board, never of its history, and a lens attached at any time, or
 * attached again, starts from exactly what the canvas shows.
 *
 * Transient ops (a wire pulse) leave no state and are not kept.
 */

import type { CanvasName } from "@shared/model";
import type { CardFact, NodeId, SceneOp, SeatLive, WireFact, WireId, WireRouteFact } from "../contract";

type Last<K extends SceneOp["kind"]> = Extract<SceneOp, { kind: K }>;

export type SceneSnapshot = {
  readonly apply: (ops: ReadonlyArray<SceneOp>) => void;
  /** The ops that rebuild the current state, load first. Empty before any load. */
  readonly ops: () => SceneOp[];
};

export const createSceneSnapshot = (): SceneSnapshot => {
  let canvas: CanvasName | undefined;
  const cards = new Map<NodeId, CardFact>();
  const wires = new Map<WireId, WireFact>();
  const seats = new Map<NodeId, SeatLive>();
  const routes = new Map<WireId, WireRouteFact>();
  let selection: Last<"selection"> | undefined;
  let reachMarks: Last<"reachMarks"> | undefined;
  let theme: Last<"theme"> | undefined;
  let wireMode: Last<"wireMode"> | undefined;
  let preview: Last<"preview"> | undefined;
  let reach: Last<"reach"> | undefined;
  let editing: Last<"editing"> | undefined;

  const fold = (op: SceneOp): void => {
    switch (op.kind) {
      case "load":
        canvas = op.canvas;
        cards.clear();
        wires.clear();
        seats.clear();
        routes.clear();
        for (const card of op.cards) cards.set(card.id, card);
        for (const wire of op.wires) wires.set(wire.id, wire);
        return;
      case "card":
        cards.set(op.fact.id, op.fact);
        return;
      case "removeCard":
        cards.delete(op.id);
        seats.delete(op.id);
        return;
      case "wire":
        wires.set(op.fact.id, op.fact);
        return;
      case "removeWire":
        wires.delete(op.id);
        routes.delete(op.id);
        return;
      case "seat":
        seats.set(op.id, op.live);
        return;
      case "routes":
        for (const id of op.remove) routes.delete(id);
        for (const route of op.set) routes.set(route.id, route);
        return;
      case "selection":
        selection = op;
        return;
      case "reachMarks":
        reachMarks = op;
        return;
      case "theme":
        theme = op;
        return;
      case "wireMode":
        wireMode = op;
        return;
      case "preview":
        preview = op;
        return;
      case "reach":
        reach = op;
        return;
      case "editing":
        editing = op;
        return;
      case "pulse":
        return;
    }
  };

  return {
    apply: (ops) => {
      for (const op of ops) fold(op);
    },
    ops: () => {
      if (canvas === undefined) return [];
      const out: SceneOp[] = [];
      // Theme first: the load paints in the mode the canvas shows.
      if (theme !== undefined) out.push(theme);
      out.push({ kind: "load", canvas, cards: [...cards.values()], wires: [...wires.values()] });
      for (const [id, live] of seats) out.push({ kind: "seat", id, live });
      if (routes.size > 0) out.push({ kind: "routes", set: [...routes.values()], remove: [] });
      for (const op of [selection, reachMarks, wireMode, preview, reach, editing]) if (op !== undefined) out.push(op);
      return out;
    },
  };
};
