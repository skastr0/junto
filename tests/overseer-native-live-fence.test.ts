import { Effect, Fiber } from "effect";
import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { makeOverseerNativeLive } from "../src/main/vellum-command/overseer/native";
import { ManagedTerminalDrive } from "../src/main/vellum-command/term/drive";
import type { TermPlane } from "../src/main/vellum-command/term/plane";
import type { ChatService } from "../src/main/vellum-command/chat/service";

const doc: CanvasDoc = { nodes: [{
  id: "worker", type: "text", text: "Worker", x: 0, y: 0, width: 240, height: 120,
  ether: {
    entity: { kind: "agent", name: "local:worker" }, host: "local",
    terminal: { bindingId: "worker-binding", harness: "codex" },
  },
}], edges: [] };

describe("Live native mutation fences", () => {
  it("does not submit a stale prompt after correction during clipboard admission", async () => {
    let enterClipboard!: () => void;
    let releaseClipboard!: () => void;
    const entered = new Promise<void>((resolve) => { enterClipboard = resolve; });
    const clipboard = new Promise<void>((resolve) => { releaseClipboard = resolve; });
    const writes: string[] = [];
    const drive = new ManagedTerminalDrive({
      isSeatIdle: () => true,
      write: (_bindingId, bytes) => { writes.push(bytes); return true; },
      assertClipboardSafe: async () => { enterClipboard(); await clipboard; return true; },
      stallWatch: false,
      pasteToCrSettleMs: 0,
    });
    const native = makeOverseerNativeLive({
      termPlane: { router: { isLocalHostId: () => true } } as unknown as TermPlane,
      chats: {} as ChatService,
      captureApplicationPage: async () => ({ ok: false, unavailable: true, reason: "not used" }),
      liveOverseerGrant: async () => true,
      listCanvasDocuments: async () => [{ name: "factory", doc }],
      occupySeat: async () => false,
      managedDrive: drive,
    });
    const fiber = Effect.runFork(native.executeResult(
      { canvasName: "factory", nodeId: "controller" },
      { operation: "agent.prompt", args: { nodeId: "worker", text: "obsolete request" } },
    ));
    await entered;
    const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
    // Allow interruption to reach the retained native flight before admitting
    // clipboard use. The target worker remains alive throughout this test.
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseClipboard();
    await interrupted;
    expect(writes).toEqual([]);
  });
});
