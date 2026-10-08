import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import type { Command } from "../src/shared/model";
import {
  canvasMutationsQuiesced,
  editText,
  showOpenedCanvas,
  hasPendingCanvasChanges,
  undo,
} from "../src/renderer/lib/mutations";
import { docNow, heldShape, loadDoc } from "./support/open-document";
import {
  flushCanvasEdits,
  quiesceAndFlushCanvasEdits,
  registerCanvasDraftCommit,
  runCanvasAuthoringOperation,
} from "../src/renderer/lib/canvas-editor-flush";
import { state$ } from "../src/renderer/lib/state";

const note = (text: string): CanvasDoc => ({
  nodes: [{ id: "note", type: "text", text, x: 0, y: 0, width: 120, height: 60 }],
  edges: [],
});

const modelCommand = vi.fn(async (_command: Command) => ({ seq: 1 }));

/** The text each command sent so far set on the note. */
const textsSent = (): unknown[] =>
  modelCommand.mock.calls.map(([command]) =>
    command._tag === "Edit" && command.change.kind === "note" ? command.change.text : command._tag,
  );

const runtimeWindow = {
  junto: {
    modelCommand,
    readCanvas: async (name: string) => ({
      name,
      doc: note("disk"),
      revision: "disk-r1",
    }),
    createCanvas: async (name: string) => ({
      name,
      doc: note("created"),
      revision: "created-r1",
    }),
    listCanvases: async () => [],
  },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: () => true,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

afterEach(() => {
  vi.useRealTimers();
});

describe("renderer canvas quiesce boundary", () => {
  it("closes mutation admission synchronously, drains the final draft, and rejects late async work", async () => {
    vi.useFakeTimers();
    modelCommand.mockClear();
    modelCommand.mockResolvedValue({ seq: 1 });
    state$.canvasName.set("alpha");
    state$.error.set("");
    state$.saveState.set("saved");
    loadDoc(note("base"), "alpha-r1", "alpha");

    // Ordinary navigation/window flush stays non-quiescing and permits later edits.
    editText("note", "normal-flush");
    await flushCanvasEdits("navigation");
    expect(canvasMutationsQuiesced()).toBe(false);
    expect(textsSent()).toEqual(["normal-flush"]);

    let finishQueuedSend!: (result: { readonly seq: number }) => void;
    const queuedSend = new Promise<{ readonly seq: number }>((resolve) => {
      finishQueuedSend = resolve;
    });
    modelCommand.mockImplementationOnce(async () => queuedSend);
    editText("note", "queued-before-quiesce");
    const unregister = registerCanvasDraftCommit(() => editText("note", "final-editor-draft"));
    let finishAuthoringOperation!: () => void;
    const authoringOperationGate = new Promise<void>((resolve) => {
      finishAuthoringOperation = resolve;
    });
    const activeAuthoringOperation = runCanvasAuthoringOperation(async () => {
      await authoringOperationGate;
      // Models an operation admitted before quiescence that asks the window
      // to show its canvas only after the latch has closed.
      showOpenedCanvas("alpha");
      return "created-before-quiesce";
    });

    const quiesce = quiesceAndFlushCanvasEdits();
    unregister();

    // The async function has not crossed its first await yet: admission is
    // already closed and the registered draft is the final accepted revision.
    expect(canvasMutationsQuiesced()).toBe(true);
    expect(docNow()).toEqual(heldShape(note("final-editor-draft")));
    const committedVersion = state$.docVersion.peek();
    const committedEpoch = state$.docEpoch.peek();

    editText("note", "late-commit");
    undo();
    const lateAuthoringOperation = vi.fn(async () => "late-create");
    await expect(runCanvasAuthoringOperation(lateAuthoringOperation)).resolves.toBeUndefined();

    expect(docNow()).toEqual(heldShape(note("final-editor-draft")));
    expect(state$.docVersion.peek()).toBe(committedVersion);
    expect(state$.docEpoch.peek()).toBe(committedEpoch);
    expect(lateAuthoringOperation).not.toHaveBeenCalled();

    // Quiesce waits every direct authorial operation admitted before the latch.
    let quiesced = false;
    void quiesce.then(() => {
      quiesced = true;
    });
    await Promise.resolve();
    expect(quiesced).toBe(false);
    finishAuthoringOperation();
    await expect(activeAuthoringOperation).resolves.toBe("created-before-quiesce");
    expect(docNow()).toEqual(heldShape(note("final-editor-draft")));
    expect(state$.docVersion.peek()).toBe(committedVersion);
    expect(state$.docEpoch.peek()).toBe(committedEpoch);

    for (let turn = 0; turn < 8 && modelCommand.mock.calls.length < 2; turn += 1) {
      await Promise.resolve();
    }
    // Edits go out one at a time, in order: the one made before the quiesce is
    // still on its way, and the final draft waits behind it.
    expect(textsSent()).toEqual(["normal-flush", "queued-before-quiesce"]);
    expect(hasPendingCanvasChanges("alpha")).toBe(true);

    finishQueuedSend({ seq: 2 });
    await quiesce;
    expect(textsSent()).toEqual(["normal-flush", "queued-before-quiesce", "final-editor-draft"]);
    expect(hasPendingCanvasChanges("alpha")).toBe(false);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(modelCommand).toHaveBeenCalledTimes(3);
    expect(docNow()).toEqual(heldShape(note("final-editor-draft")));
    expect(state$.docVersion.peek()).toBe(committedVersion);
    expect(state$.docEpoch.peek()).toBe(committedEpoch);
  });
});
