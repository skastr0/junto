/**
 * The machine-list push crosses the preload: main relays `machinesChanged`
 * and the window's `followMachines` reads `machine.list` again. Locked here
 * because the window's own test swaps the API in and would not see a preload
 * that never registered the channel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS, type JuntoApi } from "../src/shared/ipc";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => void>(),
  exposed: new Map<string, unknown>(),
  removed: [] as Array<readonly [string, unknown]>,
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) => electron.exposed.set(name, value),
  },
  ipcRenderer: {
    invoke: () => Promise.resolve(undefined),
    on: (channel: string, listener: (event: unknown, payload: unknown) => void) => electron.handlers.set(channel, listener),
    removeListener: (channel: string, listener: unknown) => electron.removed.push([channel, listener]),
    send: vi.fn(),
  },
}));

const load = async (): Promise<JuntoApi> => {
  await import("../src/window/preload/index");
  const api = electron.exposed.get("junto") as JuntoApi | undefined;
  if (api === undefined) throw new Error("preload did not expose Junto API");
  return api;
};

beforeEach(() => {
  vi.resetModules();
  electron.handlers.clear();
  electron.exposed.clear();
  electron.removed.length = 0;
});

describe("preload machinesChanged", () => {
  it("hands each machine-list push to its listener until it unsubscribes", async () => {
    const api = await load();
    const pushes: number[] = [];
    const stop = api.onMachinesChanged(() => pushes.push(pushes.length + 1));

    const listener = electron.handlers.get(IPC_CHANNELS.machinesChanged);
    expect(listener).toBeTypeOf("function");
    listener!({}, {});
    listener!({}, {});
    expect(pushes).toEqual([1, 2]);

    stop();
    expect(electron.removed.map(([channel]) => channel)).toEqual([IPC_CHANNELS.machinesChanged]);
  });
});
