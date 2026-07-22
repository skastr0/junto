import { describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { formatNodeRef } from "../src/shared/node-ref";
import { cacheBrowserSession } from "../src/renderer/lib/browser-state";
import {
  canvasMutationsQuiesced,
  deleteNode,
  loadDoc,
} from "../src/renderer/lib/mutations";
import { quiesceAndFlushCanvasEdits } from "../src/renderer/lib/canvas-editor-flush";
import { state$ } from "../src/renderer/lib/state";

const pageDoc: CanvasDoc = {
  nodes: [{
    id: "page",
    type: "link",
    url: "https://example.com",
    x: 0,
    y: 0,
    width: 320,
    height: 180,
    ether: {
      entity: { kind: "page" },
      browser: { profile: "personal", onDelete: "kill-session" },
    },
  }],
  edges: [],
};

describe("renderer delete quiesce boundary", () => {
  it("drains a pre-latch Stop Page and refuses all late delete continuations", async () => {
    let finishStop!: (result: { readonly ok: true }) => void;
    const browserStop = vi.fn(
      () => new Promise<{ readonly ok: true }>((resolve) => {
        finishStop = resolve;
      }),
    );
    const writeCanvas = vi.fn(async () => ({ revision: "written" }));
    const runtimeWindow = {
      vellum: {
        writeCanvas,
        browserStop,
        browserSessionList: async () => ({ ok: true, data: [] }),
      },
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
      confirm: () => true,
    };
    (globalThis as unknown as { window: typeof runtimeWindow }).window = runtimeWindow;

    state$.canvasName.set("quiesce-delete");
    state$.error.set("");
    loadDoc(pageDoc, "page-r1", "quiesce-delete");
    const ref = formatNodeRef({ canvasName: "quiesce-delete", nodeId: "page" });
    cacheBrowserSession({
      sessionId: "page-session",
      ref,
      nodeId: "page",
      url: "https://example.com",
      profile: "personal",
      state: "ready",
      attached: false,
    });

    deleteNode("page");
    await vi.waitFor(() => expect(browserStop).toHaveBeenCalledWith("page-session"));

    let acknowledged = false;
    const quiesce = quiesceAndFlushCanvasEdits().then(() => {
      acknowledged = true;
    });
    expect(canvasMutationsQuiesced()).toBe(true);
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    finishStop({ ok: true });
    await quiesce;

    // The destructive call admitted before the latch is terminal, but its
    // returning continuation cannot mutate or save the final document.
    expect(state$.doc.peek()).toEqual(pageDoc);
    expect(writeCanvas).not.toHaveBeenCalled();

    deleteNode("page");
    await Promise.resolve();
    expect(browserStop).toHaveBeenCalledTimes(1);
    expect(state$.doc.peek()).toEqual(pageDoc);
  });
});
