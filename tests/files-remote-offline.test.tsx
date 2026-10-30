// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesChanged, FilesRefusal } from "../src/shared/files";
import { asNodeId } from "../src/shared/physics/schema";
import { asCanvasName } from "../src/shared/model";
import { files as filesNode } from "./support/model-nodes";
import { THIS_MACHINE } from "./support/machines";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Files over SSH is off in ship; these are its renderer half, so the build here turns it on.
const flags = vi.hoisted(() => ({ filesRemote: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get FILES_REMOTE_ENABLED() {
    return flags.filesRemote;
  },
}));

const { FilesCard } = await import("../src/renderer/components/files/FilesCard");
const { FilesNode } = await import("../src/renderer/components/files/FilesNode");
const { FileView } = await import("../src/renderer/components/file-view/FileView");
const { installFilesSource, makeLocalFiles, unreachableLine, refusedOf, useFilesRoot } = await import("../src/renderer/lib/files-source");
const { modelStore } = await import("../src/renderer/lib/use-model");
const { state$ } = await import("../src/renderer/lib/state");

const MINUTE = 60_000;
const nodeId = asNodeId("files-remote");
let root: Root;
let host: HTMLDivElement;

const flush = async (): Promise<void> => {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  });
};

const unreachable = (lastReachedAt: number | null): FilesRefusal => ({ error: "unreachable", machine: "mini", lastReachedAt });

beforeEach(() => {
  state$.settings.machine.name.set(THIS_MACHINE);
  modelStore.adopt({ canvas: asCanvasName("c"), seq: 0, wires: [], nodes: [filesNode("files-remote", { host: "mini" })] });
  state$.canvasName.set("c");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  flags.filesRemote = true;
  act(() => root.unmount());
  host.remove();
  installFilesSource(null);
});

describe("the unreachable line", () => {
  const now = 1_000 * MINUTE;
  it("names the machine and says when it was last reached", () => {
    expect(unreachableLine("Mac mini", now - 30_000, now)).toBe("Cannot reach Mac mini. Last reached less than a minute ago.");
    expect(unreachableLine("Mac mini", now - MINUTE, now)).toBe("Cannot reach Mac mini. Last reached a minute ago.");
    expect(unreachableLine("Mac mini", now - 5 * MINUTE, now)).toBe("Cannot reach Mac mini. Last reached 5 minutes ago.");
    expect(unreachableLine("Mac mini", now - 60 * MINUTE, now)).toBe("Cannot reach Mac mini. Last reached an hour ago.");
    expect(unreachableLine("Mac mini", now - 180 * MINUTE, now)).toBe("Cannot reach Mac mini. Last reached 3 hours ago.");
    expect(unreachableLine("Mac mini", now - 24 * 60 * MINUTE, now)).toBe("Cannot reach Mac mini. Last reached a day ago.");
    expect(unreachableLine("Mac mini", now - 3 * 24 * 60 * MINUTE, now)).toBe("Cannot reach Mac mini. Last reached 3 days ago.");
  });

  it("says a machine never reached as such, and never a time in the future", () => {
    expect(unreachableLine("Mac mini", null, now)).toBe("Cannot reach Mac mini. Check that it is on.");
    expect(unreachableLine("Mac mini", now + MINUTE, now)).toBe("Cannot reach Mac mini. Last reached less than a minute ago.");
  });

  it("keeps the machine only from an unreachable refusal", () => {
    expect(refusedOf(unreachable(5))).toEqual({ state: "refused", error: "unreachable", offline: { machine: "mini", lastReachedAt: 5 } });
    expect(refusedOf({ error: "elsewhere" })).toEqual({ state: "refused", error: "elsewhere" });
  });
});

describe("a Files node whose machine is unreachable", () => {
  function Root() {
    const loaded = useFilesRoot({ canvas: "c", node: nodeId });
    return <p data-testid="root">{loaded.state === "refused" ? `${loaded.error} ${loaded.offline?.machine ?? "-"}` : loaded.state}</p>;
  }

  it("is refused with its machine on open, and again when the link drops under an open folder", async () => {
    const listeners = new Set<(event: FilesChanged) => void>();
    const local = makeLocalFiles({ "a.md": "" });
    let reachable = false;
    installFilesSource({
      ...local,
      open: async (at) => (reachable ? local.open(at) : { ok: false, ...unreachable(null) }),
      onChange: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    await act(async () => root.render(<Root />));
    await flush();
    expect(document.querySelector('[data-testid="root"]')?.textContent).toBe("unreachable mini");
    reachable = true;
    await act(async () => {
      for (const listener of listeners) listener({ node: nodeId, kind: "back" });
    });
    await flush();
    expect(document.querySelector('[data-testid="root"]')?.textContent).toBe("ready");
    await act(async () => {
      for (const listener of listeners) listener({ node: nodeId, kind: "closed", ...unreachable(Date.now()) });
    });
    expect(document.querySelector('[data-testid="root"]')?.textContent).toBe("unreachable mini");
  });

  it("says on its card that it cannot reach its machine and when it was last reached", async () => {
    installFilesSource({ ...makeLocalFiles(), count: async () => ({ ok: false, ...unreachable(Date.now() - 5 * MINUTE) }) });
    const node = filesNode("files-remote", { host: "mini" });
    await act(async () => root.render(<FilesCard node={node} />));
    await flush();
    expect(document.querySelector('[data-testid="files-card"]')?.textContent).toContain("Cannot reach mini. Last reached 5 minutes ago.");
  });

  it("is the stub card it is today while Files over SSH is off", async () => {
    flags.filesRemote = false;
    let asked = false;
    installFilesSource({
      ...makeLocalFiles(),
      count: async () => {
        asked = true;
        return { ok: false, ...unreachable(null) };
      },
    });
    await act(async () => root.render(<FilesCard node={filesNode("files-remote", { host: "mini" })} />));
    await flush();
    expect(asked).toBe(false);
    expect(document.querySelector('[data-testid="files-card"]')?.textContent).not.toContain("Cannot reach");
  });

  it("offers neither its default app nor Finder for a file it cannot preview", async () => {
    installFilesSource(makeLocalFiles({ "a.zip": { size: 10 } }));
    await act(async () => root.render(<FileView canvasName="c" nodeId={nodeId} path={"a.zip" as never} boxes={[]} onDraft={() => undefined} />));
    await flush();
    expect(document.querySelector('[data-testid="file-view-other"]')).not.toBeNull();
    const names = [...document.querySelectorAll("button")].map((button) => button.textContent);
    expect(names).not.toContain("Open in default app");
    expect(names).not.toContain("Reveal in Finder");
  });

  it("says in its modal that it cannot reach its machine, with no tree, filter or create", async () => {
    installFilesSource({ ...makeLocalFiles({ "a.md": "" }), open: async () => ({ ok: false, ...unreachable(Date.now() - 5 * MINUTE) }) });
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} onClose={() => undefined} />));
    await flush();
    expect(document.querySelector('[role="alert"].files-refused')?.textContent).toContain("Cannot reach mini. Last reached 5 minutes ago.");
    expect(document.querySelector("nav.files-tree-nav")).toBeNull();
    expect(document.querySelector('input[aria-label^="Filter files in "]')).toBeNull();
    expect(document.querySelector('button[aria-label="New file"]')).toBeNull();
  });

  it("offers no default app or Finder in its modal while it is reached", async () => {
    installFilesSource(makeLocalFiles({ "a.zip": { size: 10 }, "big.txt": { size: 6 * 1024 * 1024 } }));
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} onClose={() => undefined} />));
    await flush();
    const labels = (): Array<string | null> =>
      [...document.querySelectorAll("button")].map((button) => button.getAttribute("aria-label") ?? button.textContent);
    expect(document.querySelector("nav.files-tree-nav")).not.toBeNull();
    expect(labels()).not.toContain("Reveal folder in Finder");
    act(() => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<FilesNode canvasName="c" nodeId={nodeId} initialPath={"big.txt" as never} onClose={() => undefined} />));
    await flush();
    expect(document.querySelector(".files-head__name")?.textContent).toBe("big.txt");
    expect(labels()).not.toContain("Open in default app");
    expect(labels()).not.toContain("Reveal in Finder");
  });
});
