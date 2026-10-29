// @vitest-environment jsdom
/**
 * Cmd+T, from the chord to the first keystroke (docs/plans/0.11/11-quick-capture.md, Q1).
 * The surface must open with the caret in the new document, not on its frame:
 * press the chord, type, and the words are the document's.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { asNodeId } from "../src/shared/physics/schema";
import { makeLocalArtifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { mintItemId, mintOpId } from "../src/shared/resource-command";
import { setCaptureInbox } from "../src/renderer/lib/capture-inbox";
import { installKeyDispatcher } from "../src/renderer/lib/key-dispatcher";
import { KEY_ACTIONS } from "../src/renderer/lib/key-actions";
import { operatorModal$ } from "../src/renderer/lib/operator-modal";
import { isMac } from "../src/renderer/lib/platform";
import { state$ } from "../src/renderer/lib/state";
import { setNodeViewStore } from "../src/renderer/lib/node-view-state";
import { makeMemoryNodeViewStore } from "../src/renderer/lib/view-state-stand-in";
import { loadLazySurfaces } from "../src/renderer/lib/lazy-surface";
import { OperatorModalHost } from "../src/renderer/components/operator-modal/OperatorModalHost";
import { modelStore } from "../src/renderer/lib/use-model";
import { asCanvasName } from "../src/shared/model";
import { artifacts, region } from "./support/model-nodes";

await loadLazySurfaces();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; the editor measures itself.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const CANVAS = "quick-capture-open";
const INBOX = asNodeId("inbox");
const NODES = [region("junto", { x: 0, y: 0, width: 1600, height: 1000 }, { label: "Junto" }), artifacts("inbox", { x: 10, y: 10, label: "Inbox" })];

let host: HTMLDivElement;
let root: Root;
let release: () => void;
let source: ArtifactsSource;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};

const editor = (): HTMLElement | null => document.querySelector<HTMLElement>(".quick-capture .cm-content");

const pressChord = async (): Promise<void> => {
  await act(async () => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "t",
        metaKey: isMac(),
        ctrlKey: !isMac(),
        bubbles: true,
        cancelable: true,
      }),
    );
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  setNodeViewStore(makeMemoryNodeViewStore());
  source = makeLocalArtifactsSource();
  setArtifactsSource(source);
  state$.canvasName.set(CANVAS);
  modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
  setCaptureInbox(CANVAS, INBOX);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  release = installKeyDispatcher(KEY_ACTIONS);
});

afterEach(() => {
  release();
  act(() => root.unmount());
  host.remove();
  operatorModal$.open.set(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Cmd+T lands the keyboard in a new document", () => {
  it("opens on the chord, with the caret in the document, and the first typed words are its text", async () => {
    await act(async () => root.render(<OperatorModalHost />));
    expect(editor()).toBeNull();

    await pressChord();
    expect(operatorModal$.open.peek()).toBe("capture");
    // The engine loads lazily; the surface is up before its line is.
    for (let i = 0; i < 40 && editor() === null; i += 1) await settle();

    const line = editor();
    expect(line).not.toBeNull();
    // The caret is in the document, not on the frame around it.
    expect(document.activeElement).toBe(line);

    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".quick-capture .cm-editor")!);
    await act(async () => {
      view!.dispatch({ changes: { from: 0, insert: "Call Ana about rates" }, userEvent: "input.type" });
    });
    // A rest sends it; leaving the line hears it at once.
    await act(async () => {
      line!.dispatchEvent(new FocusEvent("blur"));
    });
    await settle();

    const [head] = await source.list(CANVAS, INBOX);
    expect(head?.body).toEqual({ type: "document", markdown: "Call Ana about rates" });
  });

  it("closes on one Escape with the words in the Inbox", async () => {
    await act(async () => root.render(<OperatorModalHost />));
    await pressChord();
    for (let i = 0; i < 40 && editor() === null; i += 1) await settle();
    const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".quick-capture .cm-editor")!);
    await act(async () => {
      view!.dispatch({ changes: { from: 0, insert: "Kept words" }, userEvent: "input.type" });
    });

    // One press: the surface closes, and the typing is the artifact's.
    await act(async () => {
      editor()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(operatorModal$.open.peek()).toBeNull();
    await settle();

    const [head] = await source.list(CANVAS, INBOX);
    expect(head?.body).toEqual({ type: "document", markdown: "Kept words" });
  });

  it("the preview follows the row: a second document shows its own body, not the first one's", async () => {
    const create = (title: string, markdown: string) =>
      source.apply(CANVAS, INBOX, mintItemId() as never, mintOpId(), {
        op: "create",
        title,
        body: { type: "document", markdown },
      });
    expect((await create("Alpha", "Alpha body")).kind).toBe("applied");
    expect((await create("Beta", "Beta body")).kind).toBe("applied");

    await act(async () => root.render(<OperatorModalHost />));
    await pressChord();
    for (let i = 0; i < 40 && editor() === null; i += 1) await settle();

    // The list reads asynchronously; the arrows act on what is there.
    for (let i = 0; i < 40 && document.querySelectorAll(".quick-capture__row").length < 2; i += 1) await settle();
    expect(document.querySelectorAll(".quick-capture__row")).toHaveLength(2);

    // The arrows belong to the list once the search field holds the keyboard.
    const search = document.querySelector<HTMLInputElement>(".quick-capture__search input")!;
    await act(async () => search.focus());
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    });
    await settle();

    const preview = document.querySelector(".quick-capture__preview");
    expect(preview?.textContent).toContain("Beta body");
    expect(preview?.textContent).not.toContain("Alpha body");
  });

  it("closes on the chord with the document kept, and focus back where it was", async () => {
    const before = document.createElement("button");
    document.body.append(before);
    before.focus();
    await act(async () => root.render(<OperatorModalHost />));
    await pressChord();
    for (let i = 0; i < 40 && editor() === null; i += 1) await settle();
    await pressChord();
    expect(operatorModal$.open.peek()).toBeNull();
    await settle();
    expect(document.activeElement).toBe(before);
    before.remove();
  });
});
