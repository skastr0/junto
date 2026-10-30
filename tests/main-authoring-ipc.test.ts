import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Effect, Exit } from "effect";
import { IPC_CHANNELS } from "../src/shared/ipc";
import type { CoreClient } from "../src/main/core-process/client";
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
  // The core port asks for an Exit, not a value (inProcessCore); beforeEach sets the value.
  runPromiseExit: vi.fn(),
  runFork: vi.fn(),
}));

vi.mock("electron", () => ({
  // Observability's own wiring hangs a before-quit hook off app.once; nothing here quits.
  app: { getVersion: () => "0.0.0-test", once: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => electron.handlers.set(channel, handler),
  },
}));

vi.mock("../src/main/runtime", () => ({ AppRuntime: runtime }));
vi.mock("../src/main/junto/browser/ipc", () => ({ registerBrowserIpc: vi.fn() }));
vi.mock("../src/main/junto/hosts/ipc", () => ({ registerHostsIpc: vi.fn() }));
vi.mock("../src/main/junto/settings/ipc", () => ({ registerSettingsIpc: vi.fn() }));
vi.mock("../src/main/junto/term/ipc", () => ({ registerTerminalIpc: vi.fn() }));
vi.mock("../src/main/junto/term/plane", () => ({ termPlane: {} }));
// Every core call here answers "executed"; the seat awareness read at registration is not under test.
vi.mock("../src/main/junto/term/seat-awareness", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  seatAwarenessEnrolled: () => false,
}));

const handlerFor = (channel: string): InvokeHandler => {
  const handler = electron.handlers.get(channel);
  if (handler === undefined) throw new Error(`${channel} handler was not registered`);
  return handler;
};

/**
 * The core every call here reaches: it runs the effect on the mocked runtime
 * and answers what that runtime says. The subject is the handlers' admission
 * and routing, not an operation body, so no body is loaded.
 */
const answered: CoreClient = {
  call: ((name: string) => {
    void name;
    return runtime.runPromiseExit(Effect.void).then((exit) =>
      Exit.isSuccess(exit) ? (exit.value as never) : Promise.reject(new Error("the core refused the call")));
  }) as CoreClient["call"],
};

beforeEach(async () => {
  vi.resetModules();
  electron.handlers.clear();
  runtime.runPromise.mockClear();
  runtime.runPromise.mockResolvedValue("executed");
  runtime.runPromiseExit.mockImplementation(async () => Exit.succeed("executed"));
  // The main module graph is fresh after resetModules: install the core client
  // that graph will call, as boot does.
  const { useCoreClient } = await import("../src/main/core-process/main-client");
  useCoreClient(answered);
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

    for (const name of ["list-canvases", "read-canvas", "write-canvas", "canvas-overseer-set", "create-canvas", "delete-canvas"]) {
      expect(electron.handlers.has(`junto:${name}`)).toBe(false);
    }
    const command = handlerFor(IPC_CHANNELS.modelCommand);
    const sender = { sender: trustedSender } as const;
    const edit = { _tag: "Edit", canvas: "final", id: "note", change: { kind: "note", text: "saved" } };

    await expect(command(sender, edit)).resolves.toBe("executed");
    const callsAfterOrdinary = runtime.runPromiseExit.mock.calls.length;

    // Quit still admits the same model command path for the open draft.
    mainAuthoringGate.beginFinalFlush();
    await expect(command(sender, edit)).resolves.toBe("executed");
    expect(runtime.runPromiseExit).toHaveBeenCalledTimes(callsAfterOrdinary + 1);
    expect(runtime.runPromiseExit).toHaveBeenCalledTimes(callsAfterOrdinary + 1);

    expect(() => command({ sender: {
      id: 72, isDestroyed: () => false, getURL: () => "junto-app://renderer/index.html",
    } }, edit)).toThrow(TrustedRendererRefused);

    mainAuthoringGate.close();
    await expect(command(sender, edit)).rejects.toBeInstanceOf(MainAuthoringRefused);
    expect(runtime.runPromiseExit).toHaveBeenCalledTimes(callsAfterOrdinary + 1);
  });
});
