/**
 * Files import copies only paths a real drop carried (0.11 release checklist,
 * section 3; 3776924fc). The preload reports each OS path it saw on a dropped
 * File; main's `files:import` copies a source only if that window's preload
 * reported it, and each such path once. A renderer call alone cannot name a
 * source. Electron's IPC is faked; the gate under test is the real one in
 * src/main/junto/files/ipc.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IPC_CHANNELS } from "@shared/ipc";

type Listener = (event: { readonly sender: FakeSender }, ...args: ReadonlyArray<unknown>) => unknown;
type FakeSender = { readonly id: number; once: (name: string, run: () => void) => void; isDestroyed: () => boolean };

const handlers = new Map<string, Listener>();
const imported: Array<ReadonlyArray<string>> = [];

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: Listener) => handlers.set(channel, listener),
    on: (channel: string, listener: Listener) => handlers.set(channel, listener),
  },
  shell: { trashItem: async () => undefined, openPath: async () => "", showItemInFolder: () => undefined },
  webContents: { fromId: () => undefined },
}));
vi.mock("../src/main/junto/trusted-main-webcontents", () => ({ trustedRendererIpc: <A>(target: A): A => target }));
vi.mock("../src/main/junto/files/index-worker-host", () => ({ workerRootIndex: {} }));
vi.mock("../src/main/junto/files/service", () => ({
  makeFilesService: () => ({
    import: async (_ref: unknown, _into: unknown, sources: ReadonlyArray<string>) => {
      imported.push(sources);
      return { ok: true, value: [] };
    },
  }),
}));

const { registerFilesIpc } = await import("../src/main/junto/files/ipc");

const sender = (id: number): FakeSender => ({ id, once: () => undefined, isDestroyed: () => false });
const REF = { canvas: "factory", node: "files-1" };
const drop = (from: FakeSender, path: string) => handlers.get(IPC_CHANNELS.filesDropped)!({ sender: from }, path);
const importFrom = (from: FakeSender, sources: ReadonlyArray<string>) =>
  handlers.get(IPC_CHANNELS.filesImport)!({ sender: from }, REF, "", sources) as Promise<{ ok: boolean; error?: string }>;

beforeEach(() => {
  handlers.clear();
  imported.length = 0;
  registerFilesIpc();
});

describe("files import copies only what a real drop carried", () => {
  it("copies a path this window's drop carried, once", async () => {
    const window = sender(1);
    drop(window, "/Users/someone/Desktop/report.pdf");
    expect(await importFrom(window, ["/Users/someone/Desktop/report.pdf"])).toMatchObject({ ok: true });
    expect(imported).toEqual([["/Users/someone/Desktop/report.pdf"]]);
    // The drop is spent: the same path again is a renderer naming a source.
    expect(await importFrom(window, ["/Users/someone/Desktop/report.pdf"])).toEqual({ ok: false, error: "denied" });
    expect(imported).toHaveLength(1);
  });

  it("refuses a path no drop carried, and copies nothing of a call that names one", async () => {
    const window = sender(1);
    expect(await importFrom(window, ["/Users/someone/.ssh/id_ed25519"])).toEqual({ ok: false, error: "denied" });
    drop(window, "/Users/someone/Desktop/a.txt");
    expect(await importFrom(window, ["/Users/someone/Desktop/a.txt", "/Users/someone/.ssh/id_ed25519"])).toEqual({ ok: false, error: "denied" });
    expect(imported).toEqual([]);
  });

  it("refuses another window's drop", async () => {
    drop(sender(1), "/Users/someone/Desktop/a.txt");
    expect(await importFrom(sender(2), ["/Users/someone/Desktop/a.txt"])).toEqual({ ok: false, error: "denied" });
    expect(imported).toEqual([]);
  });

  it("holds no relative or malformed drop", async () => {
    const window = sender(1);
    drop(window, "relative/a.txt");
    drop(window, "/a\0b");
    expect(await importFrom(window, ["relative/a.txt"])).toEqual({ ok: false, error: "invalid-path" });
    expect(await importFrom(window, ["/a\0b"])).toEqual({ ok: false, error: "invalid-path" });
    expect(imported).toEqual([]);
  });
});
