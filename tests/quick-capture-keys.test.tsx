// @vitest-environment jsdom
/**
 * Quick capture's keys, from the key table (docs/plans/0.11/11-quick-capture.md, Q3).
 * The surface's rows say: arrows move through the list and its preview, Enter
 * edits the focused capture in place, Cmd+Enter opens it in its node, Cmd+N
 * starts another capture, Cmd+L goes to the search field. They are the
 * surface's own keys, and the dispatcher never takes them, so what they do is
 * what this surface does with them.
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
// jsdom lays nothing out; the editor measures itself and the list scrolls nothing.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const CANVAS = "capture-keys";
const id = asNodeId;
const NODES = [
  region("junto", { x: 0, y: 0, width: 2000, height: 1200 }, { label: "Junto" }),
  artifacts("inbox", { x: 10, y: 10, label: "Inbox" }),
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

const press = async (target: Element, init: KeyboardEventInit): Promise<KeyboardEvent> => {
  const event = new KeyboardEvent("keydown", init);
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
};

const search = (): HTMLInputElement => {
  const field = document.querySelector<HTMLInputElement>(".quick-capture__search input");
  if (field === null) throw new Error("no search field");
  return field;
};
const editor = (): HTMLElement | null => document.querySelector(".quick-capture__write");
const editInPlace = (): HTMLElement | null => document.querySelector(".quick-capture__edit");
const activeTitle = (): string | undefined =>
  document.querySelector('.quick-capture__row[aria-current="true"] .quick-capture__row-title')?.textContent ??
  undefined;

/** Let the artifacts read land. */
const settle = async (): Promise<void> => {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
};

const seed = async (title: string, markdown: string): Promise<ItemId> => {
  const item = mintItemId();
  await source.apply(CANVAS, id("inbox"), item, mintItemId() as never, {
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
  await seed("Plan", "the plan");
  await seed("Notes", "some notes");
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

describe("quick capture's own keys", () => {
  it("moves through the list from the search field, the preview following the row", async () => {
    expect(activeTitle()).toBe("Notes");
    await press(search(), { key: "ArrowDown", bubbles: true, cancelable: true });
    expect(activeTitle()).toBe("Plan");
    const preview = document.querySelector(".quick-capture__preview-title")?.textContent;
    expect(preview).toBe("Plan");
    await press(search(), { key: "ArrowUp", bubbles: true, cancelable: true });
    expect(activeTitle()).toBe("Notes");
  });

  it("edits the focused capture in place on Enter", async () => {
    await press(search(), { key: "ArrowDown", bubbles: true, cancelable: true });
    await press(search(), { key: "Enter", bubbles: true, cancelable: true });
    expect(editInPlace()).not.toBeNull();
    expect(editor()).toBeNull();
  });

  it("starts another capture on the modifier and N, leaving the focused one behind", async () => {
    await press(search(), { key: "ArrowDown", bubbles: true, cancelable: true });
    await press(search(), { key: "Enter", bubbles: true, cancelable: true });
    expect(editInPlace()).not.toBeNull();
    await press(search(), mod("n"));
    expect(editor()).not.toBeNull();
    expect(editInPlace()).toBeNull();
  });

  it("goes to the search field on the modifier and L, from the editor", async () => {
    const writing = editor()?.querySelector<HTMLElement>(".cm-content") ?? editor();
    expect(writing).not.toBeNull();
    await press(writing!, mod("l"));
    expect(document.activeElement).toBe(search());
  });

  it("opens the focused capture in its node on the modifier and Enter, closing the surface", async () => {
    await press(search(), { key: "ArrowDown", bubbles: true, cancelable: true });
    await press(search(), mod("Enter"));
    expect(isOperatorModalOpen()).toBe(false);
  });
});

describe("quick capture's editor scope", () => {
  it("keeps bare keys while the caret is in the editor: M types rather than routes", async () => {
    // A stateful host, as the surface has: the editor is shown while it is being written in.
    const writing = editor()?.querySelector<HTMLElement>(".cm-content") ?? editor();
    expect(writing).not.toBeNull();
    await press(writing!, { key: "m", bubbles: true, cancelable: true });
    expect(editor()).not.toBeNull();
    expect(editInPlace()).toBeNull();
    expect(isOperatorModalOpen()).toBe(true);
  });

  it("does not take a bare key while the operator types in the search field", async () => {
    await press(search(), { key: "m", bubbles: true, cancelable: true });
    // m is the field's: no move dialog, no edit, the field keeps the word.
    expect(editor()).not.toBeNull();
    expect(editInPlace()).toBeNull();
  });
});
