// @vitest-environment jsdom
/**
 * Drops on the Files modal (0.11, F5). A Finder drag copies into the folder
 * under the pointer (a folder row, a file row's folder, else the root), with
 * that folder marked and named while the drag is over it; a copy never
 * overwrites, and a taken name that landed as " 2" is said. A tree drag moves,
 * one rename per item, and an item the service refuses goes back in the tree.
 *
 * The rows are built the way @pierre/trees draws them inside its shadow root
 * (data-type="item", data-item-path, data-item-type, data-item-parent-path;
 * node_modules/@pierre/trees/dist/render/rowAttributes.js), so the composed
 * path a drop reads is the real shape.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  filePathOfTree,
  finderDropTargetOf,
  importNotice,
  movesForDrop,
  parentOf,
} from "../src/renderer/lib/files-drop";
import {
  FILES_DROP_NOTICE_MS,
  useFilesDrop,
  type FilesDrop,
  type FilesDropModel,
  type FilesDropOutcome,
  type FilesDropPort,
} from "../src/renderer/components/files/useFilesDrop";
import { FilesDropHighlight } from "../src/renderer/components/files/FilesDropHighlight";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Err = "exists" | "denied";
const describeErr = (error: Err): string => (error === "exists" ? "The name is taken." : "Not allowed.");

/** A tree host whose shadow root holds rows as the library draws them. */
const treeHost = (rows: ReadonlyArray<{ path: string; type: "folder" | "file"; parent?: string; segments?: string[] }>) => {
  const host = document.createElement("div");
  const shadow = host.attachShadow({ mode: "open" });
  const byPath = new Map<string, HTMLElement>();
  for (const row of rows) {
    const button = document.createElement("button");
    button.setAttribute("data-type", "item");
    button.setAttribute("data-item-path", row.path);
    button.setAttribute("data-item-type", row.type);
    if (row.parent !== undefined) button.setAttribute("data-item-parent-path", row.parent);
    const label = document.createElement("span");
    label.textContent = row.path;
    button.append(label);
    for (const segment of row.segments ?? []) {
      const part = document.createElement("span");
      part.setAttribute("data-item-flattened-subitem", segment);
      part.textContent = segment;
      button.append(part);
      byPath.set(segment, part);
    }
    shadow.append(button);
    byPath.set(row.path, label);
  }
  return { host, at: (path: string) => byPath.get(path)! };
};

const composedFrom = (element: Element): EventTarget[] => {
  const seen: EventTarget[] = [];
  const event = new Event("probe", { bubbles: true, composed: true });
  element.addEventListener("probe", () => seen.push(...event.composedPath()), { once: true });
  element.dispatchEvent(event);
  return seen;
};

describe("where a Finder drop lands", () => {
  const { host, at } = treeHost([
    { path: "src/", type: "folder" },
    { path: "src/index.ts", type: "file", parent: "src/" },
    { path: "README.md", type: "file" },
    { path: "a/b/", type: "folder", segments: ["a/", "a/b/"] },
  ]);
  document.body.append(host);

  it("takes a folder row as the folder, without the tree's slash", () => {
    expect(finderDropTargetOf(composedFrom(at("src/"))).dir).toBe("src");
  });

  it("hands a file row's drop to its folder, and a top-level file's to the root", () => {
    expect(finderDropTargetOf(composedFrom(at("src/index.ts"))).dir).toBe("src");
    const top = finderDropTargetOf(composedFrom(at("README.md")));
    expect(top.dir).toBe("");
    expect(top.row).toBeNull();
  });

  it("takes the segment under the pointer in a flattened folder row", () => {
    expect(finderDropTargetOf(composedFrom(at("a/"))).dir).toBe("a");
    expect(finderDropTargetOf(composedFrom(at("a/b/"))).dir).toBe("a/b");
  });

  it("sends a drop outside every row to the root", () => {
    expect(finderDropTargetOf(composedFrom(host))).toEqual({ dir: "", row: null });
  });
});

describe("a tree drop's renames", () => {
  it("moves each item into the folder under its own name, and skips one already there", () => {
    expect(
      movesForDrop(["README.md", "src/index.ts", "lib/"], { kind: "directory", directoryPath: "src/" }),
    ).toEqual([
      { from: "README.md", to: "src/README.md", treeFrom: "README.md", treeTo: "src/README.md" },
      { from: "lib", to: "src/lib", treeFrom: "lib/", treeTo: "src/lib/" },
    ]);
  });

  it("moves to the root by name", () => {
    expect(movesForDrop(["src/deep/x.ts"], { kind: "root", directoryPath: null })).toEqual([
      { from: "src/deep/x.ts", to: "x.ts", treeFrom: "src/deep/x.ts", treeTo: "x.ts" },
    ]);
  });

  it("reads paths the service's way", () => {
    expect(filePathOfTree("a/b/")).toBe("a/b");
    expect(parentOf("a/b/c.ts")).toBe("a/b");
    expect(parentOf("c.ts")).toBe("");
  });
});

describe("what a copy says", () => {
  it("names one file, and the new name when its own was taken", () => {
    expect(importNotice(["/Users/me/notes.md"], ["src/notes.md"], "src")).toBe("Copied notes.md into src.");
    expect(importNotice(["/Users/me/notes.md"], ["src/notes 2.md"], "src")).toBe(
      "Copied notes.md into src as notes 2.md.",
    );
  });

  it("counts many, naming a single rename", () => {
    expect(importNotice(["/x/a.md", "/x/b.md"], ["a.md", "b.md"], "site")).toBe("Copied 2 files into site.");
    expect(importNotice(["/x/a.md", "/x/b.md"], ["a.md", "b 2.md"], "site")).toBe(
      "Copied 2 files into site, b.md as b 2.md.",
    );
    expect(importNotice(["/x/a.md", "/x/b.md", "/x/c.md"], ["a 2.md", "b 2.md", "c.md"], "site")).toBe(
      "Copied 3 files into site, 2 under new names since theirs were taken.",
    );
  });
});

describe("the modal's drops", () => {
  let container: HTMLDivElement;
  let root: Root;
  let drop: FilesDrop;
  let surfaceEl: HTMLElement;

  const ok = <A,>(value: A): FilesDropOutcome<A, Err> => ({ ok: true, value });

  const fakePort = () => {
    const imports: Array<{ dir: string; sources: ReadonlyArray<string> }> = [];
    const moves: Array<{ from: string; to: string }> = [];
    let refuseMove: string | undefined;
    let landed: ((dir: string, sources: ReadonlyArray<string>) => string[]) | undefined;
    const port: FilesDropPort<Err> = {
      pathForFile: (file) => (file.name.startsWith("web-") ? "" : `/Users/me/Desktop/${file.name}`),
      importFiles: async (dir, sources) => {
        imports.push({ dir, sources });
        return ok(
          landed?.(dir, sources) ??
            sources.map((source) => `${dir.length > 0 ? `${dir}/` : ""}${source.slice(source.lastIndexOf("/") + 1)}`),
        );
      },
      move: async (from, to) => {
        moves.push({ from, to });
        return from === refuseMove ? { ok: false, error: "denied" } : ok(undefined);
      },
    };
    return {
      port,
      imports,
      moves,
      refuse: (from: string) => {
        refuseMove = from;
      },
      landAs: (fn: (dir: string, sources: ReadonlyArray<string>) => string[]) => {
        landed = fn;
      },
    };
  };

  const tree = treeHost([
    { path: "src/", type: "folder" },
    { path: "src/index.ts", type: "file", parent: "src/" },
  ]);

  const mount = (port: FilesDropPort<Err>) => {
    function Modal() {
      drop = useFilesDrop({ port, describe: describeErr, rootLabel: "junto" });
      return (
        <section {...drop.surface} ref={(el) => void (el && (surfaceEl = el))}>
          <div ref={(el) => void (el && !el.contains(tree.host) && el.append(tree.host))} />
          <FilesDropHighlight drop={drop} />
        </section>
      );
    }
    act(() => root.render(<Modal />));
  };

  /** A native drag event as Chromium sends it from Finder. */
  const drag = (type: string, on: Element, files: ReadonlyArray<File> = [], relatedTarget: EventTarget | null = null) => {
    const event = new Event(type, { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, "dataTransfer", {
      value: { types: ["Files"], files, dropEffect: "none" },
    });
    Object.defineProperty(event, "relatedTarget", { value: relatedTarget });
    act(() => {
      on.dispatchEvent(event);
    });
    return event;
  };

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("marks the folder row and names it while a Finder drag is over it, then copies there", async () => {
    const main = fakePort();
    mount(main.port);
    const over = drag("dragover", tree.at("src/"));
    expect(over.defaultPrevented).toBe(true);
    expect(surfaceEl.getAttribute("data-drop")).toBe("folder");
    expect(container.querySelector(".files-drop__row")).not.toBeNull();
    expect(container.querySelector(".files-drop__caption")?.textContent).toBe("Copy into src");

    drag("drop", tree.at("src/"), [new File(["x"], "notes.md")]);
    await act(async () => {});
    expect(main.imports).toEqual([{ dir: "src", sources: ["/Users/me/Desktop/notes.md"] }]);
    expect(surfaceEl.getAttribute("data-drop")).toBeNull();
    expect(container.querySelector("[role=status]")?.textContent).toContain("Copied notes.md into src.");
  });

  it("marks the whole surface for a drop outside the rows, which copies into the root", async () => {
    const main = fakePort();
    main.landAs((_dir, sources) => sources.map((_, index) => (index === 0 ? "a 2.md" : "b.md")));
    mount(main.port);
    drag("dragenter", surfaceEl);
    expect(surfaceEl.getAttribute("data-drop")).toBe("root");
    expect(container.querySelector(".files-drop__row")).toBeNull();
    expect(container.querySelector(".files-drop__caption")?.textContent).toBe("Copy into junto");

    drag("drop", surfaceEl, [new File(["a"], "a.md"), new File(["b"], "b.md")]);
    await act(async () => {});
    expect(main.imports[0]?.dir).toBe("");
    expect(container.querySelector("[role=status]")?.textContent).toContain(
      "Copied 2 files into junto, a.md as a 2.md.",
    );
  });

  it("clears the mark when the drag leaves the surface, not when it crosses into the tree", () => {
    mount(fakePort().port);
    drag("dragover", tree.at("src/"));
    drag("dragleave", surfaceEl, [], tree.host);
    expect(surfaceEl.getAttribute("data-drop")).toBe("folder");
    drag("dragleave", surfaceEl, [], null);
    expect(surfaceEl.getAttribute("data-drop")).toBeNull();
  });

  it("refuses a drag that holds no Finder file, and copies nothing", async () => {
    const main = fakePort();
    mount(main.port);
    drag("drop", surfaceEl, [new File(["x"], "web-image.png")]);
    await act(async () => {});
    expect(main.imports).toEqual([]);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Only files from Finder");
  });

  it("leaves a tree drag to the tree", () => {
    mount(fakePort().port);
    const event = new Event("dragover", { bubbles: true, cancelable: true, composed: true });
    Object.defineProperty(event, "dataTransfer", { value: { types: ["text/plain"], files: [] } });
    act(() => {
      tree.at("src/").dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(surfaceEl.getAttribute("data-drop")).toBeNull();
  });

  it("lets the notice go after a while", async () => {
    vi.useFakeTimers();
    mount(fakePort().port);
    drag("drop", surfaceEl, [new File(["x"], "notes.md")]);
    await act(async () => {});
    expect(container.querySelector("[role=status]")).not.toBeNull();
    act(() => vi.advanceTimersByTime(FILES_DROP_NOTICE_MS));
    expect(container.querySelector("[role=status]")).toBeNull();
  });

  it("renames each moved row on disk, and puts back the ones the service refuses", async () => {
    const main = fakePort();
    main.refuse("lib");
    mount(main.port);
    const model: FilesDropModel & { calls: Array<[string, string]> } = {
      calls: [],
      move(from, to) {
        this.calls.push([from, to]);
      },
    };
    drop.bindModel(model);
    await act(async () => {
      drop.treeDragAndDrop.onDropComplete?.({
        draggedPaths: ["README.md", "lib/", "x.ts"],
        operation: "batch",
        target: { kind: "directory", directoryPath: "src/", flattenedSegmentPath: null, hoveredPath: "src/" },
      });
    });
    expect(main.moves).toEqual([
      { from: "README.md", to: "src/README.md" },
      { from: "lib", to: "src/lib" },
    ]);
    expect(model.calls).toEqual([
      ["src/lib/", "lib/"],
      ["src/x.ts", "x.ts"],
    ]);
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Could not move lib. Not allowed.");
  });

  it("says why when the tree refuses a move onto a taken name", () => {
    mount(fakePort().port);
    act(() =>
      drop.treeDragAndDrop.onDropError?.("collision", {
        draggedPaths: ["a.ts"],
        target: { kind: "root", directoryPath: null, flattenedSegmentPath: null, hoveredPath: null },
      }),
    );
    expect(container.querySelector("[role=alert]")?.textContent).toContain("Nothing moved.");
  });
});
