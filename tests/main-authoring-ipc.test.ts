import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
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
  runFork: vi.fn(),
}));

vi.mock("electron", () => ({
  app: { getVersion: () => "0.0.0-test" },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler),
  },
}));

vi.mock("../src/main/runtime", () => ({ AppRuntime: runtime }));
vi.mock("../src/main/junto/browser/ipc", () => ({ registerBrowserIpc: vi.fn() }));
vi.mock("../src/main/junto/chat/ipc", () => ({ registerChatIpc: vi.fn() }));
vi.mock("../src/main/junto/hosts/ipc", () => ({ registerHostsIpc: vi.fn() }));
vi.mock("../src/main/junto/settings/ipc", () => ({ registerSettingsIpc: vi.fn() }));
vi.mock("../src/main/junto/term/ipc", () => ({ registerTerminalIpc: vi.fn() }));
vi.mock("../src/main/junto/term/plane", () => ({ termPlane: {} }));

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

describe("renderer canvas authoring IPC", () => {
  it("resolves only one exact projected actor reference", async () => {
    const { resolveProjectedIpcActorRef } = await import(
      "../src/main/junto/ipc"
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
  }, 15_000);

  it("lands the renderer flush through the same handlers while the gate is closing", async () => {
    const { registerJuntoIpc } = await import("../src/main/junto/ipc");
    const {
      MainAuthoringRefused,
      mainAuthoringGate,
    } = await import("../src/main/junto/main-authoring-gate");
    const { setTrustedMainWebContents, TrustedRendererRefused } = await import(
      "../src/main/junto/trusted-main-webcontents"
    );
    const trustedSender = {
      id: 71,
      isDestroyed: () => false,
      getURL: () => "junto-app://renderer/index.html",
    };
    setTrustedMainWebContents(trustedSender as never, {
      initialUrl: "junto-app://renderer/index.html",
      allows: (url) => url === "junto-app://renderer/index.html",
    });
    registerJuntoIpc();

    const command = handlerFor(IPC_CHANNELS.modelCommand);
    const remove = handlerFor(IPC_CHANNELS.deleteCanvas);
    const sender = { sender: trustedSender } as const;
    const edit = { _tag: "Edit", canvas: "final", id: "note", change: { kind: "note", text: "saved" } };

    await expect(command(sender, edit)).resolves.toBe("executed");
    const callsAfterOrdinary = runtime.runPromise.mock.calls.length;

    // Quit still admits the same model command path for the open draft.
    mainAuthoringGate.beginFinalFlush();
    await expect(command(sender, edit)).resolves.toBe("executed");
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 1);
    await expect(remove(sender, "doomed")).rejects.toBeInstanceOf(MainAuthoringRefused);
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 1);

    expect(() => command({ sender: {
      id: 72, isDestroyed: () => false, getURL: () => "junto-app://renderer/index.html",
    } }, edit)).toThrow(TrustedRendererRefused);

    mainAuthoringGate.close();
    await expect(command(sender, edit)).rejects.toBeInstanceOf(MainAuthoringRefused);
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 1);
  });
});
