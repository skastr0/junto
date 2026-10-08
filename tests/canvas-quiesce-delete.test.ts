import { describe, expect, it, vi } from "vitest";
import { formatNodeRef } from "../src/shared/node-ref";
import { cacheBrowserSession } from "../src/renderer/lib/browser-state";
import {
  canvasMutationsQuiesced,
  deleteNode,
} from "../src/renderer/lib/mutations";
import { page } from "./support/model-nodes";
import { held, openCanvas } from "./support/open-canvas";
import { quiesceAndFlushCanvasEdits } from "../src/renderer/lib/canvas-editor-flush";
import { state$ } from "../src/renderer/lib/state";

const pageNode = page("page", { url: "https://example.com", profile: "personal", onRemove: "kill-session" });

describe("renderer delete quiesce boundary", () => {
  it("drains a pre-latch Stop Page and refuses all late delete continuations", async () => {
    let finishStop!: (result: { readonly ok: true }) => void;
    const browserStop = vi.fn(
      () => new Promise<{ readonly ok: true }>((resolve) => {
        finishStop = resolve;
      }),
    );
    const modelCommand = vi.fn(async () => ({ seq: 1 }));
    const runtimeWindow = {
      junto: {
        modelCommand,
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
    openCanvas("quiesce-delete", [pageNode]);
    const ref = formatNodeRef({ canvasName: "quiesce-delete", nodeId: "page" });
    cacheBrowserSession({
      sessionId: "page-session",
      ref,
      nodeId: "page",
      url: "https://example.com",
      hostId: "local",
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
    expect([...held().nodes.values()]).toEqual([pageNode]);
    expect(modelCommand).not.toHaveBeenCalled();

    deleteNode("page");
    await Promise.resolve();
    expect(browserStop).toHaveBeenCalledTimes(1);
    expect([...held().nodes.values()]).toEqual([pageNode]);
  });
});
