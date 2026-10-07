import type { Command } from "@shared/model";
import type { Canvas } from "@shared/model/canvas";
import { asOneAct, createEditHistory, type EditHistory, type UndoContext } from "./model-undo";

// The one way the window changes a canvas: send the commands, and remember how
// to take them back. Each canvas has its own undo. Nothing here knows what an
// edit is (model-edits.ts) or how a command reaches main (model-store.ts).

/** What authoring needs of the store. */
export type AuthoringStore = {
  /** The canvas as the window holds it now. */
  readonly canvasOf: (canvas: string) => Canvas;
  /** Send one command; rejects when main refuses it. */
  readonly send: (command: Command) => Promise<void>;
};

export type Authoring = {
  /**
   * Do what the operator asked. The commands are one act: undone together. An
   * act main refuses is not remembered, and the refusal is the caller's to show.
   */
  readonly act: (
    canvas: string,
    commands: ReadonlyArray<Command>,
    /** `remember: false` for an act that is not the operator's to take back. */
    options?: { readonly remember?: boolean },
  ) => Promise<void>;
  /** Step back; resolves false when there was nothing to undo. */
  readonly undo: (canvas: string) => Promise<boolean>;
  /** Step forward again; resolves false when there was nothing to redo. */
  readonly redo: (canvas: string) => Promise<boolean>;
  readonly canUndo: (canvas: string) => boolean;
  readonly canRedo: (canvas: string) => boolean;
  /** True while an act, an undo or a redo is still on its way to main. */
  readonly busy: () => boolean;
  /** Resolves once everything sent so far has been taken or refused. */
  readonly idle: () => Promise<void>;
  /** Forget a canvas's undo: it was closed, removed, or read again after a refusal. */
  readonly forget: (canvas: string) => void;
  /** Hear when what can be undone or redone may have changed. Returns the stop function. */
  readonly onChange: (listener: (canvas: string) => void) => () => void;
};

export const createAuthoring = (
  store: AuthoringStore,
  context: (canvas: string) => UndoContext = () => ({}),
): Authoring => {
  const histories = new Map<string, EditHistory>();
  const listeners = new Set<(canvas: string) => void>();
  // One act at a time per window: an undo worked out against the canvas must
  // not run while the act before it is still on its way.
  let queue: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  const historyOf = (canvas: string): EditHistory => {
    let history = histories.get(canvas);
    if (history === undefined) {
      history = createEditHistory();
      histories.set(canvas, history);
    }
    return history;
  };
  const changed = (canvas: string): void => {
    for (const listener of listeners) listener(canvas);
  };
  const forget = (canvas: string): void => {
    if (histories.delete(canvas)) changed(canvas);
  };
  const inTurn = <T>(run: () => Promise<T>): Promise<T> => {
    waiting += 1;
    const next = queue.then(run, run).finally(() => {
      waiting -= 1;
    });
    queue = next.catch(() => undefined);
    return next;
  };
  const sendAll = async (commands: ReadonlyArray<Command>): Promise<void> => {
    for (const command of commands) await store.send(command);
  };

  const turn = (canvas: string, direction: "undo" | "redo"): Promise<boolean> =>
    inTurn(async () => {
      const step = historyOf(canvas)[direction](store.canvasOf(canvas), context(canvas));
      if (step.length === 0) return false;
      changed(canvas);
      try {
        await sendAll(step);
      } catch (error) {
        // The canvas is no longer what the remembered steps were worked out
        // against; the store reads it again, and undo starts over.
        forget(canvas);
        throw error;
      }
      return true;
    });

  return {
    act: (canvas, commands, options) =>
      commands.length === 0
        ? Promise.resolve()
        : inTurn(async () => {
            const before = store.canvasOf(canvas);
            const ctx = context(canvas);
            // Several commands are one act: main takes all of them or none.
            const act = commands[0] === undefined ? commands : asOneAct(commands[0].canvas, commands);
            await sendAll(act);
            if (options?.remember === false) return;
            historyOf(canvas).record(before, act, ctx);
            changed(canvas);
          }),
    undo: (canvas) => turn(canvas, "undo"),
    redo: (canvas) => turn(canvas, "redo"),
    canUndo: (canvas) => histories.get(canvas)?.canUndo() ?? false,
    canRedo: (canvas) => histories.get(canvas)?.canRedo() ?? false,
    busy: () => waiting > 0,
    idle: async () => {
      while (waiting > 0) await queue;
    },
    forget,
    onChange: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
