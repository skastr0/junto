import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Effect, Exit } from "effect";
import { IPC_CHANNELS } from "../src/shared/ipc";
import { unansweredCoreClients } from "./support/core-clients";

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
  // A runner that asks for an Exit, not a value; beforeEach sets the value.
  runPromiseExit: vi.fn(),
  runFork: vi.fn(),
}));

vi.mock("electron", () => ({
  // Observability's own wiring hangs a before-quit hook off app.once; nothing here quits.
  app: { getVersion: () => "0.0.0-test", once: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler),
    // The window link's open (app/window/ipc.ts) is a send, not an invoke: nothing here opens one.
    on: vi.fn(),
  },
}));

vi.mock("../src/app/runtime", () => ({ AppRuntime: runtime }));
vi.mock("../src/app/browser/ipc", () => ({ registerBrowserIpc: vi.fn() }));
vi.mock("../src/app/hosts/ipc", () => ({ registerHostsIpc: vi.fn() }));
vi.mock("../src/app/settings/ipc", () => ({ registerSettingsIpc: vi.fn() }));
vi.mock("../src/app/term/ipc", () => ({ registerTerminalIpc: vi.fn() }));
vi.mock("../src/core/term/plane", () => ({ termPlane: {} }));
// Every core call here answers "executed"; the seat awareness read at registration is not under test.
vi.mock("../src/core/term/seat-awareness", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  seatAwarenessEnrolled: () => false,
}));

const handlerFor = (channel: string): InvokeHandler => {
  const handler = electron.handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} handler was not registered`);
  return handler;
};

beforeEach(async () => {
  vi.resetModules();
  electron.handlers.clear();
  runtime.runPromise.mockClear();
  runtime.runPromise.mockResolvedValue("executed");
  runtime.runPromiseExit.mockImplementation(async () => Exit.succeed("executed"));
});

describe("renderer canvas authoring IPC", () => {
  it("lands the renderer flush through the same handlers while the gate is closing", async () => {
    const { registerJuntoIpc } = await import("../src/app/ipc");
    const {
      MainAuthoringRefused,
      mainAuthoringGate,
    } = await import("../src/node/main-authoring-gate");
    const { setTrustedMainWebContents, TrustedRendererRefused } = await import(
      "../src/app/trusted-main-webcontents"
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
    registerJuntoIpc({
      core: await unansweredCoreClients(),
      surfacePlanes: { current: () => undefined },
      update: {
        host: { quiesceForInstall: async () => undefined, relaunchWithoutInstall: () => undefined },
        provider: {} as never,
      },
      // Main's notifications are served on a link nothing here opens.
      notifications: {} as never,
    });

    for (const name of ["list-canvases", "read-canvas", "write-canvas", "canvas-overseer-set", "create-canvas", "delete-canvas"]) {
      expect(electron.handlers.has(`junto:${name}`)).toBe(false);
    }
    const command = handlerFor(IPC_CHANNELS.modelCommand);
    const sender = { sender: trustedSender } as const;
    const edit = { _tag: "Edit", canvas: "final", id: "note", change: { kind: "note", text: "saved" } };

    await expect(command(sender, edit)).resolves.toBe("executed");
    // Main's model client runs each command on main's runtime (model/model-ipc.ts).
    const callsAfterOrdinary = runtime.runPromise.mock.calls.length;

    // Quit still admits the same model command path for the open draft.
    mainAuthoringGate.beginFinalFlush();
    await expect(command(sender, edit)).resolves.toBe("executed");
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 1);

    expect(() => command({ sender: {
      id: 72, isDestroyed: () => false, getURL: () => "junto-app://renderer/index.html",
    } }, edit)).toThrow(TrustedRendererRefused);

    mainAuthoringGate.close();
    await expect(command(sender, edit)).rejects.toBeInstanceOf(MainAuthoringRefused);
    expect(runtime.runPromise).toHaveBeenCalledTimes(callsAfterOrdinary + 1);
  });
});
