// @vitest-environment jsdom
/**
 * Files over SSH, the place a Files node names: the wizard and the inspector
 * offer this machine and the active pins, default to this machine, and type a
 * remote folder as an absolute path. A machine that left the list opens
 * nothing and says so.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/model";
import { OPERATOR_PROTOCOL_VERSION } from "../src/shared/operator-control";
import type { NodeOf } from "../src/shared/model";
import { files as filesNode } from "./support/model-nodes";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Files over SSH is off in ship; these are its renderer half, so the build here turns it on.
const flags = vi.hoisted(() => ({ filesRemote: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get FILES_REMOTE_ENABLED() {
    return flags.filesRemote;
  },
}));

vi.hoisted(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const { FilesWizard } = await import("../src/window/components/files/FilesWizard");
const { FilesNode } = await import("../src/window/components/files/FilesNode");
const { FilesCard } = await import("../src/window/components/files/FilesCard");
const { NodeFieldEditors } = await import("../src/window/components/InspectorFields");
const { filesMachineChoices } = await import("../src/window/lib/machines");
const { installFilesSource, makeLocalFiles, FILES_MACHINE_GONE_LINE } = await import("../src/window/lib/files-source");
const { modelStore } = await import("../src/window/lib/use-model");
const { state$ } = await import("../src/window/lib/state");

type Request = { readonly id: string; readonly op: string; readonly args: Record<string, unknown> };
const ok = (request: Request, data: unknown) => ({ protocol: OPERATOR_PROTOCOL_VERSION, id: request.id, op: request.op, ok: true, data });
const listed = (id: string, label: string, setUp: boolean, isThisMachine = false) => ({
  machine: { id, label, isThisMachine, capabilities: ["terminal"] as const },
  setUp,
  needsUpdate: false,
  ...(setUp ? { installationId: `inst-${id}` } : {}),
});

const makeApi = () => {
  const requests: Request[] = [];
  const modelCommand = vi.fn(async (_command: unknown) => ({ seq: 1 }));
  const hostDirectoryRead = vi.fn(async (hostId: string, path: string) => ({ root: path.startsWith("/") ? path : "/Users/op", parent: "/Users", entries: [] }));
  const machineCommand = vi.fn(async (request: Request): Promise<unknown> => {
    requests.push(request);
    switch (request.op) {
      case "machine.list":
        return ok(request, {
          machines: [
            listed(THIS_MACHINE, "Studio", true, true),
            listed(OTHER_MACHINE, "Mac mini", true),
            listed("box", "Boat box", true),
            listed("old", "Old laptop", false),
          ],
        });
      case "machine.boat-status":
        return ok(request, {
          connected: true,
          keyId: "0123abcd",
          unrevokedKeyIds: [],
          machines: [{ machineName: "box", sandboxId: "bx_abcd1234", size: "small", power: "awake" }],
        });
      default:
        return ok(request, {});
    }
  });
  return { requests, modelCommand, hostDirectoryRead, machineCommand, api: { modelCommand, hostDirectoryRead, machineCommand } };
};

let root: Root;
let host: HTMLDivElement;
let oldApi: typeof window.junto;
let releaseCanvas: (() => void) | undefined;

const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    for (let index = 0; index < 40; index += 1) await Promise.resolve();
  });
};
const until = async (check: () => boolean): Promise<void> => {
  for (let index = 0; index < 100; index += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
};
const press = async (element: Element | null | undefined): Promise<void> => {
  if (!(element instanceof HTMLElement)) throw new Error("nothing to press");
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
  await flush();
};
const write = async (input: HTMLInputElement, value: string): Promise<void> => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await flush();
};
const byLabel = (label: string): Element | null =>
  document.querySelector(`[aria-label="${label}"]`) ?? [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === label) ?? null;
const option = (label: string): Element | undefined =>
  [...document.querySelectorAll('[role="option"]')].find((row) => row.textContent?.trim() === label);

beforeEach(() => {
  oldApi = window.junto;
  flags.filesRemote = true;
  state$.settings.machine.name.set(THIS_MACHINE);
  state$.canvasName.set("files-place");
  state$.machines.set([]);
  state$.machineFacts.set({});
  releaseCanvas = modelStore.adopt({ canvas: asCanvasName("files-place"), seq: 0, wires: [], nodes: [] });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  releaseCanvas?.();
  releaseCanvas = undefined;
  state$.machines.set([]);
  state$.machineFacts.set({});
  installFilesSource(null);
  (window as unknown as { junto: unknown }).junto = oldApi;
  flags.filesRemote = true;
});

describe("the machine choice", () => {
  it("is this machine first, then active pins by name, with no Boat or retired machine", () => {
    const machines = [
      { id: THIS_MACHINE, label: "Studio", isThisMachine: true, capabilities: ["terminal" as const] },
      { id: OTHER_MACHINE, label: "Mac mini", isThisMachine: false, capabilities: ["terminal" as const] },
      { id: "box", label: "Boat box", isThisMachine: false, capabilities: ["terminal" as const] },
      { id: "old", label: "Old laptop", isThisMachine: false, capabilities: ["terminal" as const] },
    ];
    const facts = {
      [THIS_MACHINE]: { setUp: true, needsUpdate: false },
      [OTHER_MACHINE]: { setUp: true, needsUpdate: false },
      box: { setUp: true, needsUpdate: false },
      old: { setUp: false, needsUpdate: false },
    };
    expect(filesMachineChoices(machines, facts, new Set(["box"]), THIS_MACHINE)).toEqual([
      { id: THIS_MACHINE, label: "Studio" },
      { id: OTHER_MACHINE, label: "Mac mini" },
    ]);
  });
});

describe("the wizard", () => {
  it("defaults to this machine and browses its folders", async () => {
    const owner = makeApi();
    (window as unknown as { junto: unknown }).junto = owner.api;
    await act(async () => root.render(<FilesWizard anchor={{ x: 20, y: 20 }} onClose={() => undefined} />));
    await until(() => (byLabel("Machine")?.textContent ?? "").includes("Studio"));
    expect(byLabel("Machine")?.textContent).toContain("Studio");
    expect(owner.hostDirectoryRead).toHaveBeenCalledWith(THIS_MACHINE, "~");
    expect(document.querySelector('input[aria-label="Files folder"]')?.getAttribute("role")).not.toBe("textbox");
  });

  it("takes a typed absolute folder on a pinned machine and creates the node there", async () => {
    const owner = makeApi();
    (window as unknown as { junto: unknown }).junto = owner.api;
    const closed = vi.fn();
    await act(async () => root.render(<FilesWizard anchor={{ x: 20, y: 20 }} onClose={closed} />));
    await flush();
    await press(byLabel("Machine"));
    await press(option("Mac mini"));
    expect(owner.hostDirectoryRead).not.toHaveBeenCalledWith(OTHER_MACHINE, "~");
    const folder = document.querySelector<HTMLInputElement>('input[aria-label="Files folder"]');
    expect(folder).not.toBeNull();
    expect(folder?.value).toBe("");
    expect(document.body.textContent).toContain("A folder path on Mac mini.");
    await write(folder!, "/srv/app");
    await press(byLabel("Create files"));
    expect(closed).toHaveBeenCalled();
    const command = owner.modelCommand.mock.calls[0]?.[0] as { _tag?: string; nodes?: ReadonlyArray<NodeOf<"files">> };
    expect(command._tag).toBe("Add");
    expect(command.nodes?.[0]).toMatchObject({ kind: "files", host: OTHER_MACHINE, root: "/srv/app" });
  });

  it("keeps today's folder picker and no machine choice while the flag is off", async () => {
    flags.filesRemote = false;
    const owner = makeApi();
    (window as unknown as { junto: unknown }).junto = owner.api;
    await act(async () => root.render(<FilesWizard anchor={{ x: 20, y: 20 }} onClose={() => undefined} />));
    await flush();
    expect(document.querySelector('[aria-label="Machine"]')).toBeNull();
    expect(document.querySelector('[role="combobox"][aria-label="Files folder"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("A folder path on");
  });
});

describe("the inspector", () => {
  it("changes the machine and keeps the folder as that machine's absolute path", async () => {
    const owner = makeApi();
    (window as unknown as { junto: unknown }).junto = owner.api;
    const id = asNodeId("files-inspector");
    const node: NodeOf<"files"> = filesNode("files-inspector", { host: THIS_MACHINE, root: "/Users/op/app" });
    modelStore.node$("files-place", id).set(node);
    modelStore.canvas$("files-place").nodeIds.set([id]);
    await act(async () => root.render(<NodeFieldEditors nodeId={id} />));
    await flush();
    expect(byLabel("Files machine")?.textContent).toContain("Studio");
    await press(byLabel("Files machine"));
    await press(option("Mac mini"));
    expect(document.body.textContent).toContain("A folder path on Mac mini.");
    expect(owner.modelCommand).toHaveBeenCalledWith(expect.objectContaining({
      _tag: "Edit",
      id,
      change: expect.objectContaining({ kind: "files", host: OTHER_MACHINE }),
    }));
  });
});

describe("the core's not-set-up refusal", () => {
  it("shows the line and the Machines window when the core refuses a folder on an unset-up machine", async () => {
    const owner = makeApi();
    (window as unknown as { junto: unknown }).junto = owner.api;
    installFilesSource({
      ...makeLocalFiles({ "a.md": "" }),
      open: async () => ({ ok: false, error: "not-set-up", machine: OTHER_MACHINE }),
    });
    const id = asNodeId("files-not-set-up");
    modelStore.node$("files-place", id).set(filesNode("files-not-set-up", { host: OTHER_MACHINE }));
    modelStore.canvas$("files-place").nodeIds.set([id]);
    await act(async () => root.render(<FilesNode canvasName="files-place" nodeId={id} onClose={() => undefined} />));
    await flush();
    expect(document.body.textContent).toContain(FILES_MACHINE_GONE_LINE);
    expect(byLabel("Open Machines")).not.toBeNull();
    expect(document.querySelector("nav.files-tree-nav")).toBeNull();
  });
});

describe("a machine removed while its folder is shown", () => {
  const rows = () => [
    listed(THIS_MACHINE, "Studio", true, true).machine,
    listed(OTHER_MACHINE, "Mac mini", true).machine,
  ];

  it("refreshes the open modal to the not-set-up line and Open Machines", async () => {
    installFilesSource(makeLocalFiles({ "a.md": "" }));
    const id = asNodeId("files-machine-removed");
    modelStore.node$("files-place", id).set(filesNode("files-machine-removed", { host: OTHER_MACHINE }));
    modelStore.canvas$("files-place").nodeIds.set([id]);
    state$.machines.set(rows());
    await act(async () => root.render(<FilesNode canvasName="files-place" nodeId={id} onClose={() => undefined} />));
    await flush();
    expect(document.querySelector("nav.files-tree-nav")).not.toBeNull();

    await act(async () => { state$.machines.set([rows()[0]!]); });
    await flush();

    expect(document.body.textContent).toContain(FILES_MACHINE_GONE_LINE);
    expect(byLabel("Open Machines")).not.toBeNull();
    expect(document.querySelector("nav.files-tree-nav")).toBeNull();
  });

  it("refreshes the card and asks its count again", async () => {
    const count = vi.fn(async () => ({ ok: false as const, error: "unreachable" as const, machine: OTHER_MACHINE, lastReachedAt: Date.now() - 30_000 }));
    installFilesSource({ ...makeLocalFiles(), count });
    state$.machines.set(rows());
    await act(async () => root.render(<FilesCard node={filesNode("files-machine-removed-card", { host: OTHER_MACHINE })} />));
    await flush();
    expect(document.querySelector('[data-testid="files-card"]')?.textContent).toContain("Cannot reach Mac mini");
    const asked = count.mock.calls.length;

    await act(async () => { state$.machines.set([rows()[0]!]); });
    await flush();

    expect(document.querySelector('[data-testid="files-card"]')?.textContent).toContain(FILES_MACHINE_GONE_LINE);
    expect(count.mock.calls.length).toBeGreaterThan(asked);
  });
});
