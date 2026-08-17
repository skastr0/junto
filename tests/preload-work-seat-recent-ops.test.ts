import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  IPC_CHANNELS,
  type VellumCommandApi,
} from "../src/shared/ipc";

const electron = vi.hoisted(() => ({
  exposed: new Map<string, unknown>(),
  invoked: [] as Array<ReadonlyArray<unknown>>,
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (name: string, value: unknown) =>
      electron.exposed.set(name, value),
  },
  ipcRenderer: {
    invoke: (...args: ReadonlyArray<unknown>) => {
      electron.invoked.push(args);
      return Promise.resolve(undefined);
    },
    on: vi.fn(),
    removeListener: vi.fn(),
    send: vi.fn(),
  },
}));

const loadPreload = async (): Promise<VellumCommandApi> => {
  await import("../src/preload/index");
  const api = electron.exposed.get("vellumCommand") as
    | VellumCommandApi
    | undefined;
  if (api === undefined) {
    throw new Error("preload did not expose Vellum Command API");
  }
  return api;
};

beforeEach(() => {
  vi.resetModules();
  electron.exposed.clear();
  electron.invoked.length = 0;
});

describe("preload actor-seat recent operations", () => {
  it("forwards the narrow canvas, actor node, and optional limit contract", async () => {
    const api = await loadPreload();

    await api.workSeatRecentOps("factory", "worker", 17);

    expect(electron.invoked).toEqual([
      [
        IPC_CHANNELS.workSeatRecentOps,
        "factory",
        "worker",
        17,
      ],
    ]);
  });
});
