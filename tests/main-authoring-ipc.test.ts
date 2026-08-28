import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { actorRefFixture } from "./helpers/actor-ref-fixtures";

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
  app: { getVersion: () => "0.0.0-test" },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: { showOpenDialog: vi.fn() },
  clipboard: { availableFormats: () => [] },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler),
  },
}));

vi.mock("../src/main/runtime", () => ({ AppRuntime: runtime }));
vi.mock("../src/main/vellum/browser/ipc", () => ({ registerBrowserIpc: vi.fn() }));
vi.mock("../src/main/vellum/chat/ipc", () => ({ registerChatIpc: vi.fn() }));
vi.mock("../src/main/vellum/hosts/ipc", () => ({ registerHostsIpc: vi.fn() }));
vi.mock("../src/main/vellum/settings/ipc", () => ({ registerSettingsIpc: vi.fn() }));
vi.mock("../src/main/vellum/term/ipc", () => ({ registerTerminalIpc: vi.fn() }));
vi.mock("../src/main/vellum/term/plane", () => ({ termPlane: {} }));

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

afterEach(async () => {
  const { productLicenseAdmission } = await import(
    "../src/main/vellum/license/admission"
  );
  productLicenseAdmission.revoke();
});

describe("renderer canvas authoring IPC", () => {
  it(
    "propagates canvas bootstrap failure before renderer handlers are admitted",
    async () => {
      const bootstrapError = new Error("stale canvas authority head");
      runtime.runPromise.mockRejectedValueOnce(bootstrapError);
      const { registerVellumIpc } = await import("../src/main/vellum/ipc");

      await expect(registerVellumIpc()).rejects.toBe(bootstrapError);
      expect(electron.handlers.size).toBe(0);
      expect(runtime.runPromise).toHaveBeenCalledTimes(1);
    },
    15_000,
  );

  it("keeps background service startup off the canvas readiness promise", async () => {
    runtime.runPromise
      .mockResolvedValueOnce("canvas-ready")
      .mockImplementationOnce(() => new Promise<string>(() => {}));
    const { registerVellumIpc } = await import("../src/main/vellum/ipc");

    await expect(registerVellumIpc()).resolves.toBeUndefined();
    expect(electron.handlers.size).toBeGreaterThan(0);
    expect(runtime.runPromise.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("propagates canvas bootstrap failure through top-level IPC registration", async () => {
    const bootstrapError = new Error("orphan canvas generations");
    runtime.runPromise.mockRejectedValueOnce(bootstrapError);
    const { registerIpcHandlers } = await import("../src/main/ipc");

    await expect(registerIpcHandlers()).rejects.toBe(bootstrapError);
    expect(electron.handlers.size).toBe(0);
  });

  it("resolves only one exact projected actor reference", async () => {
    const { resolveProjectedIpcActorRef } = await import(
      "../src/main/vellum/ipc"
    );
    const actor = actorRefFixture("agent", "factory");
    expect(
      resolveProjectedIpcActorRef([actor], "factory", "agent"),
    ).toEqual(actor);
    expect(
      resolveProjectedIpcActorRef([], "factory", "agent"),
    ).toBeUndefined();
    expect(
      resolveProjectedIpcActorRef(
        [
          actor,
          {
            ...actor,
            seatId: actorRefFixture("other", "factory").seatId,
          },
        ],
        "factory",
        "agent",
      ),
    ).toBeUndefined();
  });

  it("lands the renderer flush through the same handlers while the gate is closing", async () => {
    const { registerVellumIpc } = await import("../src/main/vellum/ipc");
    const { productLicenseAdmission } = await import(
      "../src/main/vellum/license/admission"
    );
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
    // This test exercises authoring admission after the independent product
    // startup boundary has already admitted the trusted renderer.
    productLicenseAdmission.admit("development");
    await registerVellumIpc();

    const write = handlerFor(IPC_CHANNELS.writeCanvas);
    const create = handlerFor(IPC_CHANNELS.createCanvas);
    const remove = handlerFor(IPC_CHANNELS.deleteCanvas);
    const sender = { sender: trustedSender } as const;
    const doc = { nodes: [], edges: [] } as CanvasDoc;

    await expect(write(sender, "ordinary", doc, "r0")).resolves.toBe("executed");
    const callsAfterOrdinary = runtime.runPromise.mock.calls.length;

    // Quit begins: the operator's open drafts still have a save path.
    mainAuthoringGate.beginFinalFlush();
    await expect(write(sender, "final", doc, "r1")).resolves.toBe("executed");
    await expect(create(sender, "recovery")).resolves.toBe("executed");
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 2);

    // Nothing else may author during that window.
    await expect(remove(sender, "doomed")).rejects.toBeInstanceOf(MainAuthoringRefused);
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 2);

    // Only the trusted renderer reaches these handlers at all.
    expect(() =>
      write(
        {
          sender: {
            id: 72,
            isDestroyed: () => false,
            getURL: () => "vellum-app://renderer/index.html",
          },
        },
        "cross-sender",
        doc,
        "r1",
      ),
    ).toThrow(TrustedRendererRefused);

    mainAuthoringGate.close();
    await expect(write(sender, "after-close", doc, "r1")).rejects.toBeInstanceOf(
      MainAuthoringRefused,
    );
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 2);
  });
});
