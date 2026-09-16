import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, CanvasNode } from "../src/shared/canvas";
import { quiesceAndFlushCanvasEdits } from "../src/renderer/lib/canvas-editor-flush";
import {
  canvasMutationsQuiesced,
  deleteNode,
  deleteNodes,
  loadDoc,
} from "../src/renderer/lib/mutations";
import { state$ } from "../src/renderer/lib/state";

type AgentDeleteResource = {
  readonly kind: "agent";
  readonly agentKey: string;
};

const confirmDelete = vi.fn(() => true);
type TerminalDeleteResource = { readonly bindingId: string; readonly hostId?: string };
const cleanTerminalDelete = (resources: ReadonlyArray<TerminalDeleteResource>) => ({
  ok: true as const,
  leaseId: "terminal-delete-lease",
  closeResults: resources.map((resource) => ({
    bindingId: resource.bindingId,
    hostId: resource.hostId ?? "local",
    clean: true as const,
  })),
});
const terminalBeginNodeDelete = vi.fn(
  async (resources: ReadonlyArray<TerminalDeleteResource>) =>
    cleanTerminalDelete(resources),
);
const terminalFinishNodeDelete = vi.fn(
  async () => ({ ok: true as const }),
);
const writeCanvas = vi.fn(async () => ({ revision: "written" }));
const chatBeginNodeDelete = vi.fn(
  async (resources: ReadonlyArray<AgentDeleteResource>) => ({
    ok: true as const,
    leaseId: "managed-delete-lease",
    closeResults: resources.map((resource) => ({
      agentKey: resource.agentKey,
      ok: true,
      clean: true,
    })),
  }),
);
const chatFinishNodeDelete = vi.fn(
  async () => ({ ok: true as const }),
);

const runtimeWindow = {
  vellumCommand: {
    writeCanvas,
    terminalBeginNodeDelete,
    terminalFinishNodeDelete,
    chatBeginNodeDelete,
    chatFinishNodeDelete,
  },
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  confirm: confirmDelete,
};
(globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

const managedAgent = ({
  id,
  bindingId,
  agentKey = "local:shared",
  hostId,
}: {
  readonly id: string;
  readonly bindingId: string;
  readonly agentKey?: string;
  readonly hostId?: string;
}): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 220,
  height: 84,
  ether: {
    entity: { kind: "agent", name: agentKey },
    terminal: { bindingId, harness: "claude" },
    ...(hostId === undefined ? {} : { host: hostId }),
  },
});

const agentDoc = (...nodes: ReadonlyArray<CanvasNode>): CanvasDoc => ({
  nodes: [...nodes],
  edges: [],
});

const open = (doc: CanvasDoc): void => {
  state$.canvasName.set("managed-agent-delete");
  loadDoc(doc, "revision-1", "managed-agent-delete");
};

describe.sequential("managed agent node terminal teardown", () => {
  beforeEach(() => {
    state$.error.set("");
    confirmDelete.mockReset();
    confirmDelete.mockReturnValue(true);
    terminalBeginNodeDelete.mockReset();
    terminalBeginNodeDelete.mockImplementation(async (resources) =>
      cleanTerminalDelete(resources)
    );
    terminalFinishNodeDelete.mockReset();
    terminalFinishNodeDelete.mockResolvedValue({ ok: true });
    writeCanvas.mockReset();
    writeCanvas.mockResolvedValue({ revision: "written" });
    chatBeginNodeDelete.mockReset();
    chatBeginNodeDelete.mockImplementation(async (resources) => ({
      ok: true as const,
      leaseId: "managed-delete-lease",
      closeResults: resources.map((resource) => ({
        agentKey: resource.agentKey,
        ok: true,
        clean: true,
      })),
    }));
    chatFinishNodeDelete.mockReset();
    chatFinishNodeDelete.mockResolvedValue({ ok: true });
  });

  it("awaits the exact terminal stop after confirmation and before document commit", async () => {
    const node = managedAgent({
      id: "seat-a",
      bindingId: "binding-a",
      hostId: "studio",
    });
    open(agentDoc(node));
    let finishTerminalDelete!: () => void;
    terminalBeginNodeDelete.mockImplementationOnce(
      (resources) => new Promise((resolve) => {
        finishTerminalDelete = () => resolve(cleanTerminalDelete(resources));
      }),
    );

    deleteNode("seat-a");

    await vi.waitFor(() => {
      expect(terminalBeginNodeDelete).toHaveBeenCalledWith([
        { bindingId: "binding-a", hostId: "studio" },
      ]);
    });
    expect(state$.doc.peek()).toEqual(agentDoc(node));
    expect(confirmDelete.mock.invocationCallOrder[0]).toBeLessThan(
      terminalBeginNodeDelete.mock.invocationCallOrder[0]!,
    );

    finishTerminalDelete();
    await vi.waitFor(() => expect(state$.doc.peek().nodes).toEqual([]));
    expect(chatFinishNodeDelete).toHaveBeenCalledWith(
      "managed-delete-lease",
      "committed",
    );
    expect(terminalFinishNodeDelete).toHaveBeenCalledWith(
      "terminal-delete-lease",
      "committed",
    );
  });

  it("fails closed when privileged terminal teardown rejects", async () => {
    const node = managedAgent({ id: "seat-a", bindingId: "binding-a" });
    const original = agentDoc(node);
    open(original);
    terminalBeginNodeDelete.mockRejectedValueOnce(
      new Error("terminal IPC rejected"),
    );

    deleteNode("seat-a");

    await vi.waitFor(() => expect(state$.error.peek()).toBe(
      "Junto could not stop the managed terminal cleanly; the agent node was not deleted.",
    ));
    expect(state$.doc.peek()).toEqual(original);
    expect(chatFinishNodeDelete).toHaveBeenCalledWith(
      "managed-delete-lease",
      "aborted",
    );
  });

  it("keys teardown by binding, not a shared agent key", async () => {
    const seatA = managedAgent({
      id: "seat-a",
      bindingId: "binding-a",
      agentKey: "local:duplicate",
      hostId: "station-a",
    });
    const seatB = managedAgent({
      id: "seat-b",
      bindingId: "binding-b",
      agentKey: "local:duplicate",
      hostId: "station-b",
    });
    open(agentDoc(seatA, seatB));

    deleteNode("seat-a");

    await vi.waitFor(() => {
      expect(state$.doc.peek().nodes.map((node) => node.id)).toEqual(["seat-b"]);
    });
    expect(terminalBeginNodeDelete).toHaveBeenCalledTimes(1);
    expect(terminalBeginNodeDelete).toHaveBeenCalledWith([
      { bindingId: "binding-a", hostId: "station-a" },
    ]);
    expect(chatBeginNodeDelete).toHaveBeenCalledWith([
      { kind: "agent", agentKey: "local:duplicate" },
    ]);
  });

  it("deduplicates duplicate references to the same exact binding", async () => {
    const seatA = managedAgent({
      id: "seat-a",
      bindingId: "binding-shared",
      agentKey: "local:a",
      hostId: "studio",
    });
    const seatAlias = managedAgent({
      id: "seat-alias",
      bindingId: "binding-shared",
      agentKey: "local:alias",
      hostId: "studio",
    });
    open(agentDoc(seatA, seatAlias));

    deleteNodes(["seat-a", "seat-alias"]);

    await vi.waitFor(() => expect(state$.doc.peek().nodes).toEqual([]));
    expect(terminalBeginNodeDelete).toHaveBeenCalledTimes(1);
    expect(terminalBeginNodeDelete).toHaveBeenCalledWith([
      { bindingId: "binding-shared", hostId: "studio" },
    ]);
  });

  it("accepts an exact clean receipt for a never-opened managed terminal", async () => {
    const node = managedAgent({ id: "never-opened", bindingId: "binding-cold" });
    open(agentDoc(node));

    deleteNode("never-opened");

    await vi.waitFor(() => expect(state$.doc.peek().nodes).toEqual([]));
    expect(terminalBeginNodeDelete).toHaveBeenCalledWith([
      { bindingId: "binding-cold", hostId: "local" },
    ]);
    expect(state$.error.peek()).toBe("");
  });

  it("refuses a late commit when the canvas epoch changes during terminal stop", async () => {
    const node = managedAgent({ id: "seat-a", bindingId: "binding-a" });
    open(agentDoc(node));
    let finishTerminalDelete!: () => void;
    terminalBeginNodeDelete.mockImplementationOnce(
      (resources) => new Promise((resolve) => {
        finishTerminalDelete = () => resolve(cleanTerminalDelete(resources));
      }),
    );

    deleteNode("seat-a");
    await vi.waitFor(() => expect(terminalBeginNodeDelete).toHaveBeenCalledTimes(1));
    const replacement = managedAgent({
      id: "replacement",
      bindingId: "replacement-binding",
      agentKey: "local:replacement",
    });
    loadDoc(agentDoc(replacement), "revision-2", "managed-agent-delete");
    finishTerminalDelete();

    await vi.waitFor(() => expect(state$.error.peek()).toBe(
      "Canvas changed before deletion completed; no nodes were deleted.",
    ));
    expect(state$.doc.peek()).toEqual(agentDoc(replacement));
    expect(chatFinishNodeDelete).toHaveBeenCalledWith(
      "managed-delete-lease",
      "aborted",
    );
  });

  // Quiescence is a monotonic process latch, so this proof must remain last.
  it("drains an admitted stop but rejects its commit after quiescence", async () => {
    const node = managedAgent({ id: "seat-a", bindingId: "binding-a" });
    const original = agentDoc(node);
    open(original);
    let finishTerminalDelete!: () => void;
    terminalBeginNodeDelete.mockImplementationOnce(
      (resources) => new Promise((resolve) => {
        finishTerminalDelete = () => resolve(cleanTerminalDelete(resources));
      }),
    );

    deleteNode("seat-a");
    await vi.waitFor(() => expect(terminalBeginNodeDelete).toHaveBeenCalledTimes(1));

    let acknowledged = false;
    const quiescence = quiesceAndFlushCanvasEdits().then(() => {
      acknowledged = true;
    });
    expect(canvasMutationsQuiesced()).toBe(true);
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    finishTerminalDelete();
    await quiescence;

    expect(state$.doc.peek()).toEqual(original);
    expect(writeCanvas).not.toHaveBeenCalled();
    expect(chatFinishNodeDelete).toHaveBeenCalledWith(
      "managed-delete-lease",
      "aborted",
    );
  });
});
