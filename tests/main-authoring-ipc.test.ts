import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { IPC_CHANNELS } from "../src/shared/ipc";

type InvokeEvent = Readonly<{
  sender: Readonly<{
    id: number;
    isDestroyed?: () => boolean;
    getURL?: () => string;
  }>;
}>;
type InvokeHandler = (event: InvokeEvent, ...args: ReadonlyArray<unknown>) => unknown;

const electron = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
}));

const runtime = vi.hoisted(() => ({
  runPromise: vi.fn(async (_effect: unknown): Promise<string> => "executed"),
}));

vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler),
  },
}));

vi.mock("../src/main/runtime", () => ({ AppRuntime: runtime }));
vi.mock("../src/main/vellum/browser/ipc", () => ({ registerBrowserIpc: vi.fn() }));
vi.mock("../src/main/vellum/chat/ipc", () => ({ registerChatIpc: vi.fn() }));
vi.mock("../src/main/vellum/herdr/ipc", () => ({ registerHerdrIpc: vi.fn() }));
vi.mock("../src/main/vellum/hosts/ipc", () => ({ registerHostsIpc: vi.fn() }));
vi.mock("../src/main/vellum/settings/ipc", () => ({ registerSettingsIpc: vi.fn() }));
vi.mock("../src/main/vellum/term/ipc", () => ({ registerTerminalIpc: vi.fn() }));
vi.mock("../src/main/vellum/term/plane", () => ({ termPlane: {} }));

const finalMetadata = (
  requestId: string,
  operation: "canvas.write" | "canvas.create",
): unknown => ({ __vellumFinalWrite: { requestId, operation } });

const handlerFor = (channel: string): InvokeHandler => {
  const handler = electron.handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} handler was not registered`);
  return handler;
};

beforeEach(() => {
  vi.resetModules();
  electron.handlers.clear();
  runtime.runPromise.mockClear();
  runtime.runPromise.mockResolvedValue("executed");
});

describe("renderer canvas final-write IPC", () => {
  it("binds one exact main permit to Electron sender, request, and operation", async () => {
    const { registerVellumIpc } = await import("../src/main/vellum/ipc");
    const {
      MainAuthoringRefused,
      mainAuthoringGate,
    } = await import("../src/main/vellum/main-authoring-gate");
    const { setTrustedMainWebContents, TrustedRendererRefused } = await import(
      "../src/main/vellum/trusted-main-webcontents"
    );
    const trustedSender = {
      id: 71,
      isDestroyed: () => false,
      getURL: () => "vellum-app://renderer/index.html",
    };
    setTrustedMainWebContents(trustedSender as never, {
      initialUrl: "vellum-app://renderer/index.html",
      allows: (url) => url === "vellum-app://renderer/index.html",
    });
    registerVellumIpc();

    const write = handlerFor(IPC_CHANNELS.writeCanvas);
    const create = handlerFor(IPC_CHANNELS.createCanvas);
    const sender = { sender: trustedSender } as const;
    const doc = { nodes: [], edges: [] } as CanvasDoc;

    // No private metadata is the ordinary renderer path while admission is open.
    await expect(write(sender, "ordinary", doc, "r0")).resolves.toBe("executed");
    const callsAfterOrdinary = runtime.runPromise.mock.calls.length;

    const precommit = mainAuthoringGate.beginPrecommit();
    await expect(write(sender, "late-ordinary", doc, "r1")).rejects.toBeInstanceOf(
      MainAuthoringRefused,
    );
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary);

    const requestId = "00000000-0000-4000-8000-000000000031";
    mainAuthoringGate.mintFinalWritePermit(precommit.epoch, {
      senderId: sender.sender.id,
      requestId,
    });

    const rejected = [
      // A renderer cannot supply a sender identity; surplus envelope fields fail closed.
      write(sender, "forged-sender", doc, "r1", {
        __vellumFinalWrite: { requestId, operation: "canvas.write" },
        senderId: sender.sender.id,
      }),
      // Nor can it smuggle a sender field into the private nested envelope.
      write(sender, "nested-forge", doc, "r1", {
        __vellumFinalWrite: {
          requestId,
          operation: "canvas.write",
          senderId: sender.sender.id,
        },
      }),
      write(sender, "stale-request", doc, "r1", finalMetadata(
        "00000000-0000-4000-8000-000000000032",
        "canvas.write",
      )),
      write(sender, "wrong-operation", doc, "r1", finalMetadata(
        requestId,
        "canvas.create",
      )),
      create(sender, "wrong-create-operation", finalMetadata(requestId, "canvas.write")),
      write(sender, "malformed", doc, "r1", {
        __vellumFinalWrite: { requestId: [requestId], operation: "canvas.write" },
      }),
    ];

    for (const refusal of rejected) {
      await expect(refusal).rejects.toMatchObject({
        name: expect.stringMatching(/MainAuthoringTransitionError|TrustedRendererRefused/u),
      });
    }
    expect(() =>
      write(
        { sender: { id: 72, isDestroyed: () => false, getURL: () => "vellum-app://renderer/index.html" } },
        "cross-sender",
        doc,
        "r1",
        finalMetadata(requestId, "canvas.write"),
      ),
    ).toThrow(TrustedRendererRefused);
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary);

    await expect(
      write(sender, "final", doc, "r1", finalMetadata(requestId, "canvas.write")),
    ).resolves.toBe("executed");
    await expect(
      create(sender, "recovery", finalMetadata(requestId, "canvas.create")),
    ).resolves.toBe("executed");
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 2);

    mainAuthoringGate.revokeFinalWritePermit(precommit.epoch, {
      senderId: sender.sender.id,
      requestId,
    });
    await expect(
      write(sender, "after-revoke", doc, "r1", finalMetadata(requestId, "canvas.write")),
    ).rejects.toMatchObject({ code: "invalid_final_permit" });
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 2);
  });
});
