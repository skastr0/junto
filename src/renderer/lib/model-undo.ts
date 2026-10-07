import type { Command, Node, NodeEdit, SheetGrid, Wire } from "@shared/model";
import { wiresAt, type Canvas } from "@shared/model/canvas";

// Undo, as commands. Nothing here holds a copy of a canvas: a step back is the
// commands that reverse what was done, worked out from the canvas as it stood
// just before. Running a step back gives, the same way, the step forward
// again.
//
// A grant of overseer authority is never part of a step. Undo and redo cannot
// produce `GrantOverseer`, and a seat that undo puts back comes back without
// the grant, so nothing here can restore authority the operator took away.

/** What undo needs that a canvas does not hold. */
export type UndoContext = {
  /** A sheet's grid as it stands now, for reversing a write to it. */
  readonly sheetOf?: (id: string) => SheetGrid | undefined;
};

/**
 * Why a command has no way back. `never` is by design (authority, runtime
 * records, whole canvases); `missing` is a gap in the command set.
 */
export type Irreversible = "never" | "missing";

export type Inverse =
  | { readonly _tag: "Reversed"; readonly commands: ReadonlyArray<Command> }
  | { readonly _tag: "Irreversible"; readonly why: Irreversible };

const reversed = (...commands: ReadonlyArray<Command>): Inverse => ({ _tag: "Reversed", commands });
const irreversible = (why: Irreversible): Inverse => ({ _tag: "Irreversible", why });

/** A node as undo puts it back: itself, without any grant of authority. */
const restored = (node: Node): Node => (node.kind === "agent" && node.overseer ? { ...node, overseer: false } : node);

/** The old value of each field an edit names; `null` clears one that was absent. */
const oldValues = <Row extends object>(row: Row, change: object, skip: string): Record<string, unknown> => {
  const before = row as Record<string, unknown>;
  const old: Record<string, unknown> = {};
  for (const key of Object.keys(change)) {
    if (key === skip) continue;
    old[key] = before[key] === undefined ? null : before[key];
  }
  return old;
};

/**
 * The commands that reverse `command`, given the canvas just before it. A
 * command that would change nothing reverses to no commands.
 */
export const inverseOf = (canvas: Canvas, command: Command, context: UndoContext = {}): Inverse => {
  switch (command._tag) {
    case "Add":
      return command.nodes.length === 0 && command.wires.length === 0
        ? reversed()
        : reversed({
            _tag: "Remove",
            canvas: command.canvas,
            nodes: command.nodes.map((node) => node.id),
            wires: command.wires.map((wire) => wire.id),
          });
    case "Remove": {
      const nodes = command.nodes.flatMap((id) => {
        const node = canvas.nodes.get(id);
        return node === undefined ? [] : [restored(node)];
      });
      // The wires named, and the ones that go because an end goes.
      const wires = new Map<string, Wire>();
      for (const id of command.wires) {
        const wire = canvas.wires.get(id);
        if (wire !== undefined) wires.set(wire.id, wire);
      }
      for (const node of nodes) for (const wire of wiresAt(canvas, node.id)) wires.set(wire.id, wire);
      return nodes.length === 0 && wires.size === 0
        ? reversed()
        : reversed({ _tag: "Add", canvas: command.canvas, nodes, wires: [...wires.values()] });
    }
    case "Move": {
      const moves = command.moves.flatMap((move) => {
        const node = canvas.nodes.get(move.id);
        if (node === undefined) return [];
        return [{
          id: node.id,
          x: node.x,
          y: node.y,
          ...(move.size === undefined ? {} : { size: { width: node.width, height: node.height } }),
        }];
      });
      return moves.length === 0 ? reversed() : reversed({ _tag: "Move", canvas: command.canvas, moves });
    }
    case "Recolor": {
      // One command per colour the nodes had, `null` for the ones that had none.
      const byColor = new Map<string | null, Array<Node["id"]>>();
      for (const id of command.nodes) {
        const node = canvas.nodes.get(id);
        if (node === undefined) continue;
        const color = node.color ?? null;
        byColor.set(color, [...(byColor.get(color) ?? []), node.id]);
      }
      return reversed(
        ...[...byColor].map(([color, nodes]): Command => ({ _tag: "Recolor", canvas: command.canvas, nodes, color })),
      );
    }
    case "Edit": {
      const node = canvas.nodes.get(command.id);
      if (node === undefined || node.kind !== command.change.kind) return reversed();
      const change = { kind: node.kind, ...oldValues(node, command.change, "kind") } as NodeEdit;
      return reversed({ _tag: "Edit", canvas: command.canvas, id: command.id, change });
    }
    case "Rewire": {
      const wire = canvas.wires.get(command.id);
      if (wire === undefined) return reversed();
      return reversed({
        _tag: "Rewire",
        canvas: command.canvas,
        id: command.id,
        change: oldValues(wire, command.change, "") as Extract<Command, { readonly _tag: "Rewire" }>["change"],
      });
    }
    case "WriteSheet": {
      const grid = context.sheetOf?.(command.id);
      return grid === undefined
        ? irreversible("missing")
        : reversed({ _tag: "WriteSheet", canvas: command.canvas, id: command.id, grid });
    }
    // A restack says front or back, and no command puts a node back at the
    // place in the stack it had.
    case "Restack":
      return irreversible("missing");
    case "GrantOverseer":
    case "RecordSession":
    case "CreateCanvas":
    case "RemoveCanvas":
    case "RenameCanvas":
      return irreversible("never");
  }
};

/**
 * The canvas after a command, for the commands whose result is known without
 * asking main. Used only to reverse the next command of the same step.
 */
export const canvasAfter = (canvas: Canvas, command: Command): Canvas => {
  switch (command._tag) {
    case "Add": {
      const nodes = new Map(canvas.nodes);
      for (const node of command.nodes) nodes.set(node.id, node);
      const wires = new Map(canvas.wires);
      for (const wire of command.wires) wires.set(wire.id, wire);
      return { ...canvas, nodes, wires };
    }
    case "Remove": {
      const nodes = new Map(canvas.nodes);
      const wires = new Map(canvas.wires);
      for (const id of command.wires) wires.delete(id);
      for (const id of command.nodes) {
        for (const wire of wiresAt(canvas, id)) wires.delete(wire.id);
        nodes.delete(id);
      }
      return { ...canvas, nodes, wires };
    }
    case "Move": {
      const nodes = new Map(canvas.nodes);
      for (const move of command.moves) {
        const node = nodes.get(move.id);
        if (node !== undefined) nodes.set(node.id, { ...node, x: move.x, y: move.y, ...move.size });
      }
      return { ...canvas, nodes };
    }
    case "Recolor": {
      const nodes = new Map(canvas.nodes);
      for (const id of command.nodes) {
        const node = nodes.get(id);
        if (node === undefined) continue;
        const { color: _was, ...rest } = node;
        nodes.set(node.id, (command.color === null ? rest : { ...rest, color: command.color }) as Node);
      }
      return { ...canvas, nodes };
    }
    case "Edit": {
      const node = canvas.nodes.get(command.id);
      if (node === undefined || node.kind !== command.change.kind) return canvas;
      const next: Record<string, unknown> = { ...node };
      for (const [key, value] of Object.entries(command.change)) {
        if (key === "kind") continue;
        if (value === null) delete next[key];
        else next[key] = value;
      }
      const nodes = new Map(canvas.nodes);
      nodes.set(node.id, next as Node);
      return { ...canvas, nodes };
    }
    case "Rewire": {
      const wire = canvas.wires.get(command.id);
      if (wire === undefined) return canvas;
      const next: Record<string, unknown> = { ...wire };
      for (const [key, value] of Object.entries(command.change)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      const wires = new Map(canvas.wires);
      wires.set(wire.id, next as Wire);
      return { ...canvas, wires };
    }
    default:
      return canvas;
  }
};

/**
 * The step that takes back a run of commands done as one act: each reversed
 * against the canvas as it stood when it ran, last first. Commands with no
 * way back are left out of the step and named in `skipped`.
 */
export const stepBack = (
  canvas: Canvas,
  commands: ReadonlyArray<Command>,
  context: UndoContext = {},
): { readonly back: ReadonlyArray<Command>; readonly skipped: ReadonlyArray<Command> } => {
  const back: Array<Command> = [];
  const skipped: Array<Command> = [];
  let at = canvas;
  for (const command of commands) {
    const inverse = inverseOf(at, command, context);
    if (inverse._tag === "Reversed") back.unshift(...inverse.commands);
    else skipped.push(command);
    at = canvasAfter(at, command);
  }
  return { back, skipped };
};

export type EditHistory = {
  /**
   * Note what the operator just did, given the canvas before it. Clears redo.
   * An act with no way back is not noted, and what came before it stays.
   */
  readonly record: (before: Canvas, commands: ReadonlyArray<Command>, context?: UndoContext) => void;
  /** The commands to send to step back, given the canvas now; none when there is nothing to undo. */
  readonly undo: (now: Canvas, context?: UndoContext) => ReadonlyArray<Command>;
  /** The commands to send to step forward again. */
  readonly redo: (now: Canvas, context?: UndoContext) => ReadonlyArray<Command>;
  readonly canUndo: () => boolean;
  readonly canRedo: () => boolean;
  readonly clear: () => void;
};

/** One canvas's undo and redo, as steps of commands. */
export const createEditHistory = (limit = 200): EditHistory => {
  const past: Array<ReadonlyArray<Command>> = [];
  const future: Array<ReadonlyArray<Command>> = [];
  const push = (stack: Array<ReadonlyArray<Command>>, step: ReadonlyArray<Command>): void => {
    stack.push(step);
    if (stack.length > limit) stack.shift();
  };
  /** Take a step off one stack; put the step that reverses it on the other. */
  const turn = (
    from: Array<ReadonlyArray<Command>>,
    to: Array<ReadonlyArray<Command>>,
    now: Canvas,
    context: UndoContext | undefined,
  ): ReadonlyArray<Command> => {
    const step = from.pop();
    if (step === undefined) return [];
    const { back } = stepBack(now, step, context);
    if (back.length > 0) push(to, back);
    return step;
  };
  return {
    record: (before, commands, context) => {
      const { back } = stepBack(before, commands, context);
      if (back.length === 0) return;
      push(past, back);
      future.length = 0;
    },
    undo: (now, context) => turn(past, future, now, context),
    redo: (now, context) => turn(future, past, now, context),
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    clear: () => {
      past.length = 0;
      future.length = 0;
    },
  };
};
