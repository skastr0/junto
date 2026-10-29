// @vitest-environment jsdom
/**
 * Quick capture's keys, from the key table (docs/plans/0.11/11-quick-capture.md, Q3).
 * The surface's rows say: arrows move through the list and its preview, Enter
 * edits the focused capture in place, Cmd+Enter opens it in its node, Cmd+N
 * starts another capture, Cmd+L goes to the search field. They are the
 * surface's own keys, and the dispatcher never takes them, so what they do is
 * what this surface does with them.
 *
 * The list is one combobox: the field keeps the keyboard, and the row the
 * arrows land on is the field's active descendant, so a screen reader hears
 * it. The editor is the one scope that keeps the bare keys for itself.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import { mintItemId, type ItemId } from "../src/shared/resource-command";
import {
  makeLocalArtifactsSource,
  setArtifactsSource,
  type ArtifactsSource,
} from "../src/renderer/lib/artifacts-source";
import { isOperatorModalOpen, closeOperatorModal, openOperatorModal } from "../src/renderer/lib/operator-modal";
import { setCaptureInbox } from "../src/renderer/lib/capture-inbox";
import { isMac } from "../src/renderer/lib/platform";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";
import { QuickCapture } from "../src/renderer/components/capture/QuickCapture";
import { artifacts, canvasOf, region } from "./support/model-nodes";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; CodeMirror measures itself, and the list scrolls nothing.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const CANVAS = "capture-keys";
const id = asNodeId;
const NODES = [
  region("junto", { x: 0, y: 0, width: 2000, height: 1200 }, { label: "Junto" }),
  artifacts("inbox", { x: 10, y: 10, label: "Inbox" }),
  artifacts("shelf", { x: 400, y: 10, label: "Shelf" }),
];

let host: HTMLDivElement;
let root: Root;
let release: () => void;
let source: ArtifactsSource;
let clock = 100;

/** A keydown with the platform's own modifier: Cmd on macOS, Control elsewhere. */
const mod = (key: string, alt = false): KeyboardEventInit => ({
  key,
  metaKey: isMac() && !alt,
  ctrlKey: !isMac() && !alt,
  altKey: alt,
  bubbles: true,
  cancelable: true,
});

const bare = (key: string): KeyboardEventInit => ({ key, bubbles: true, cancelable: true });

/** Let React finish what one key set off. */
const flush = async (turns = 2): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
};

const press = async (target: Element, init: KeyboardEventInit): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", init);
  await act(async () => {
    target.dispatchEvent(event);
  });
  await flush();
  return event;
};

const search = (): HTMLInputElement => {
  const field = document.querySelector<HTMLInputElement>(".quick-capture__search input");
  if (field === null) throw new Error("no search field");
  return field;
};
/** The right half's editor, whichever capture it holds. */
const editor = (): HTMLElement | null => document.querySelector(".quick-capture__right .capture-editor__surface");
const preview = (): HTMLElement | null => document.querySelector(".quick-capture__preview");
const previewTitle = (): string | undefined =>
  document.querySelector(".quick-capture__preview-title")?.textContent ?? undefined;
/** The opened artifact's title, as the editor's header holds it; empty on a new capture. */
const openTitle = (): string => document.querySelector<HTMLInputElement>('.quick-capture__right input[aria-label="Title"]')?.value ?? "";
const list = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(".quick-capture__rows");
  if (found === null) throw new Error("no list");
  return found;
};
const options = (): HTMLElement[] => [...list().querySelectorAll<HTMLElement>('[role="option"]')];
const optionTitles = (): string[] =>
  options().map((option) => option.querySelector(".quick-capture__row-title")?.textContent ?? "");
const activeOption = (): HTMLElement | undefined =>
  options().find((option) => option.getAttribute("aria-selected") === "true");
const activeTitle = (): string | undefined =>
  activeOption()?.querySelector(".quick-capture__row-title")?.textContent ?? undefined;

/** The open Move to's dialog, or null while none is open. */
const moveDialog = (): HTMLElement | null => {
  for (const dialog of document.querySelectorAll<HTMLElement>('[role="dialog"]')) {
    const labelledBy = dialog.getAttribute("aria-labelledby");
    const text = labelledBy === null ? "" : (document.getElementById(labelledBy)?.textContent?.trim() ?? "");
    if (text.startsWith("Move ")) return dialog;
  }
  return null;
};
/** Its own title, or null while none is open. */
const moveTitle = (): string | null => {
  const dialog = moveDialog();
  if (dialog === null) return null;
  const labelledBy = dialog.getAttribute("aria-labelledby");
  return labelledBy === null ? null : (document.getElementById(labelledBy)?.textContent?.trim() ?? null);
};

/** Let the artifacts read, the lazy editor and its focus claim land. */
const settle = (): Promise<void> => flush(14);

const seed = async (node: string, title: string, markdown: string): Promise<ItemId> => {
  const item = mintItemId();
  await source.apply(CANVAS, id(node), item, mintItemId() as never, {
    op: "create",
    title,
    body: { type: "document", markdown },
  });
  return item;
};

beforeEach(async () => {
  clock = 100;
  release = modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
  state$.canvasName.set(CANVAS);
  setCaptureInbox(CANVAS, "inbox");
  source = makeLocalArtifactsSource({ kind: "operator" }, () => (clock += 10));
  setArtifactsSource(source);
  await seed("inbox", "Plan", "the plan");
  await seed("inbox", "Notes", "some notes");
  // Newest of all, and outside the Inbox: recency alone would put it first.
  await seed("shelf", "Later", "kept for later");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => openOperatorModal("capture"));
  await act(async () => root.render(<QuickCapture />));
  await settle();
});

afterEach(() => {
  act(() => closeOperatorModal());
  act(() => root.unmount());
  host.remove();
  setCaptureInbox(CANVAS, null);
  release();
});

describe("quick capture opens on writing", () => {
  it("puts the caret in the new document, not on the frame", async () => {
    expect(editor()).not.toBeNull();
    expect(document.querySelector(".capture-editor__surface .cm-content")).not.toBeNull();
    const active = document.activeElement as HTMLElement | null;
    expect(active).not.toBeNull();
    expect(active!.closest(".capture-editor__surface")).not.toBeNull();
    expect(openTitle()).toBe("");
  });

  it("is one combobox: the field keeps the keyboard and names the row the arrows land on", async () => {
    const field = search();
    expect(field.getAttribute("role")).toBe("combobox");
    expect(field.getAttribute("aria-expanded")).toBe("true");
    expect(field.getAttribute("aria-controls")).toBe(list().id);
    expect(list().getAttribute("role")).toBe("listbox");
    const first = activeOption();
    expect(first).toBeDefined();
    expect(first!.getAttribute("aria-selected")).toBe("true");
    expect(field.getAttribute("aria-activedescendant")).toBe(first!.id);
  });
});

describe("quick capture's own keys", () => {
  it("lists the Inbox first, then the rest, newest first", () => {
    expect(optionTitles()).toEqual(["Notes", "Plan", "Later"]);
  });

  it("moves through the list from the search field, the preview following the row", async () => {
    expect(activeTitle()).toBe("Notes");
    await press(search(), bare("ArrowDown"));
    expect(activeTitle()).toBe("Plan");
    expect(previewTitle()).toBe("Plan");
    expect(search().getAttribute("aria-activedescendant")).toBe(activeOption()!.id);
    await press(search(), bare("ArrowUp"));
    expect(activeTitle()).toBe("Notes");
  });

  it("edits the focused capture in place on Enter", async () => {
    await press(search(), bare("ArrowDown"));
    expect(previewTitle()).toBe("Plan");
    await press(search(), bare("Enter"));
    expect(editor()).not.toBeNull();
    expect(preview()).toBeNull();
    expect(openTitle()).toBe("Plan");
  });

  it("starts another capture on the modifier and N, leaving the focused one behind", async () => {
    await press(search(), bare("ArrowDown"));
    await press(search(), bare("Enter"));
    expect(openTitle()).toBe("Plan");
    await press(search(), mod("n"));
    expect(editor()).not.toBeNull();
    expect(openTitle()).toBe("");
  });

  it("goes to the search field on the modifier and L, from the editor", async () => {
    const writing = document.activeElement as HTMLElement | null;
    expect(writing?.closest(".capture-editor__surface")).not.toBeNull();
    await press(writing!, mod("l"));
    expect(document.activeElement).toBe(search());
  });

  it("opens the focused capture in its node on the modifier and Enter, closing the surface", async () => {
    await press(search(), bare("ArrowDown"));
    await press(search(), mod("Enter"));
    expect(isOperatorModalOpen()).toBe(false);
  });

  it("moves through the list with the keyboard on the list itself", async () => {
    act(() => list().focus());
    await press(list(), bare("ArrowDown"));
    expect(activeTitle()).toBe("Plan");
    await press(list(), bare("ArrowDown"));
    expect(activeTitle()).toBe("Later");
    await press(list(), bare("ArrowUp"));
    expect(activeTitle()).toBe("Plan");
  });

  it("moves the focused artifact with M from the list, where the keyboard can sit", async () => {
    await press(search(), bare("ArrowDown"));
    expect(activeTitle()).toBe("Plan");
    // The list is its own stop: the keys that act on a row type in the field,
    // so the keyboard steps into the list for them.
    expect(list().getAttribute("tabindex")).toBe("0");
    expect(list().getAttribute("aria-activedescendant")).toBe(activeOption()!.id);
    act(() => list().focus());
    expect(document.activeElement).toBe(list());
    await press(list(), bare("m"));
    expect(moveTitle()).toBe("Move Plan");
    // The picker's one other node is Shelf: Enter moves it there.
    const target = moveDialog()?.querySelector<HTMLElement>('[role="combobox"]') ?? null;
    expect(target).not.toBeNull();
    await press(target!, bare("ArrowDown"));
    await press(target!, bare("Enter"));
    await flush(14);
    expect(moveTitle()).toBeNull();
    const shelf = await source.list(CANVAS, id("shelf"));
    expect(shelf.map((head) => head.artifact.title)).toContain("Plan");
  });
});

describe("quick capture's editor scope", () => {
  it("keeps bare keys while the caret is in the editor: M types rather than routes", async () => {
    const writing = document.activeElement as HTMLElement | null;
    expect(writing?.closest(".capture-editor__surface")).not.toBeNull();
    await press(writing!, bare("m"));
    expect(editor()).not.toBeNull();
    expect(preview()).toBeNull();
    expect(moveTitle()).toBeNull();
    expect(isOperatorModalOpen()).toBe(true);
  });

  it("does not take a bare key while the operator types in the search field", async () => {
    await press(search(), bare("m"));
    // m is the field's: no edit, no route, the field keeps the word.
    expect(editor()).not.toBeNull();
    expect(preview()).toBeNull();
    expect(openTitle()).toBe("");
    expect(moveTitle()).toBeNull();
  });
});
