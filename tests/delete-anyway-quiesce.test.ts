/**
 * Delete anyway under quiescence: a quit latch that closes while the second
 * question is open must stop the destructive re-call itself, as the Stop Page
 * path does. The latch is monotonic, so this proof lives in its own file.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Node, NodeOf } from "../src/shared/model";
import type { TerminalBeginNodeDeleteResult } from "../src/shared/ipc";
import { canvasMutationsQuiesced, deleteNode } from "../src/window/lib/mutations";
import { quiesceAndFlushCanvasEdits } from "../src/window/lib/canvas-editor-flush";
import { seat } from "./support/model-nodes";
import { held, openCanvas } from "./support/open-canvas";
import { state$ } from "../src/window/lib/state";
import { answerConfirm, confirm$, type ConfirmRequest } from "../src/window/lib/confirm";

const asks: ConfirmRequest[] = [];
const confirmDelete = vi.fn(() => true);
confirm$.pending.onChange(({ value }) => {
  if (value === null) return;
  asks.push(value);
  queueMicrotask(() => {
    if (value.source === "node-delete-unreachable") void quiesceAndFlushCanvasEdits();
    answerConfirm(confirmDelete());
  });
});

type TerminalDeleteResource = { readonly bindingId: string; readonly hostId?: string };
const cleanTerminalDelete = (resources: ReadonlyArray<TerminalDeleteResource>) => ({
  ok: true as const,
  leaseId: "terminal-delete-lease",
  closeResults: resources.map((resource) => ({
    bindingId: resource.bindingId,
    hostId: resource.hostId ?? "studio",
    clean: true as const,
  })),
});
const terminalBeginNodeDelete = vi.fn(
  async (resources: ReadonlyArray<TerminalDeleteResource>): Promise<TerminalBeginNodeDeleteResult> =>
    cleanTerminalDelete(resources),
);
const terminalFinishNodeDelete = vi.fn(async () => ({ ok: true as const }));
const modelCommand = vi.fn(async () => ({ seq: 1 }));
const runtimeWindow = {
  junto: {
    modelCommand,
    terminalBeginNodeDelete,
    terminalFinishNodeDelete,
  },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: confirmDelete,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const managedAgent = (): NodeOf<"agent"> =>
  seat("seat-a", {
    bindingId: "binding-a" as NodeOf<"agent">["bindingId"],
    width: 220,
    height: 84,
    host: "studio",
  });

describe("Delete anyway under quiescence", () => {
  beforeEach(() => {
    state$.error.set("");
    asks.length = 0;
    confirmDelete.mockReset();
    confirmDelete.mockReturnValue(true);
    terminalBeginNodeDelete.mockReset();
    terminalBeginNodeDelete.mockImplementation(async (resources) => cleanTerminalDelete(resources));
    terminalFinishNodeDelete.mockReset();
    terminalFinishNodeDelete.mockResolvedValue({ ok: true });
    modelCommand.mockReset();
    modelCommand.mockResolvedValue({ seq: 1 });
  });

  it("does not re-call the stop when the quit latch closes during the second question", async () => {
    const node = managedAgent();
    openCanvas("delete-anyway-quiesce", [node] as ReadonlyArray<Node>);
    terminalBeginNodeDelete.mockImplementationOnce(async () => ({
      ok: false as const,
      error: "terminal binding-a stop could not be proven",
      unstoppedRemote: [{ bindingId: "binding-a", hostId: "studio", reason: "unreachable" as const }],
    }));

    deleteNode("seat-a");
    await vi.waitFor(() => expect(asks).toHaveLength(2));
    await vi.waitFor(() => expect(canvasMutationsQuiesced()).toBe(true));

    expect(terminalBeginNodeDelete).toHaveBeenCalledTimes(1);
    expect(terminalFinishNodeDelete).not.toHaveBeenCalled();
    expect(state$.error.peek()).toBe("");
    expect([...held().nodes.values()]).toEqual([node]);
  });
});
