// @vitest-environment jsdom
/**
 * The Cmd+T desk's view state (0.11.6 blocker): the desk names the artifact the
 * operator left open, so Cmd+T after a close, a quit or a kill reopens those
 * words instead of a blank capture, and the pointer is written the moment the
 * first keystroke makes the artifact.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { asNodeId } from "../src/shared/physics/schema";
import { makeLocalArtifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/window/lib/artifacts-source";
import { setCaptureInbox } from "../src/window/lib/capture-inbox";
import { mintItemId, mintOpId } from "../src/shared/resource-command";
import { installKeyDispatcher } from "../src/window/lib/key-dispatcher";
import { KEY_ACTIONS } from "../src/window/lib/key-actions";
import { operatorModal$ } from "../src/window/lib/operator-modal";
import { isMac } from "../src/window/lib/platform";
import { state$ } from "../src/window/lib/state";
import { nodeViewStore, setNodeViewStore } from "../src/window/lib/node-view-state";
import { makeMemoryNodeViewStore } from "../src/window/lib/view-state-stand-in";
import { loadLazySurfaces } from "../src/window/lib/lazy-surface";
import { OperatorModalHost } from "../src/window/components/operator-modal/OperatorModalHost";
import { modelStore } from "../src/window/lib/use-model";
import { asCanvasName } from "../src/shared/model";
import { artifacts, region } from "./support/model-nodes";

await loadLazySurfaces();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const CANVAS = "quick-capture-desk";
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
      new KeyboardEvent("keydown", { key: "t", metaKey: isMac(), ctrlKey: !isMac(), bubbles: true, cancelable: true }),
    );
  });
};
const openOnChord = async (): Promise<HTMLElement> => {
  await act(async () => root.render(<OperatorModalHost />));
  await pressChord();
  for (let i = 0; i < 40 && editor() === null; i += 1) await settle();
  const line = editor();
  expect(line).not.toBeNull();
  return line!;
};
const type = async (text: string): Promise<void> => {
  const view = EditorView.findFromDOM(document.querySelector<HTMLElement>(".quick-capture .cm-editor")!);
  await act(async () => {
    view!.dispatch({ changes: { from: 0, insert: text }, userEvent: "input.type" });
  });
  await act(async () => {
    editor()!.dispatchEvent(new FocusEvent("blur"));
  });
  await settle();
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

describe("the Cmd+T desk", () => {
  it("reopens the artifact the desk names, with its words, instead of a blank capture", async () => {
    // The words a quit left behind: an Inbox artifact, and a desk pointing at it.
    const artifactId = mintItemId();
    await act(async () => {
      await source.apply(CANVAS, INBOX, artifactId, mintOpId(), {
        op: "create",
        title: "Rates call with Ana, Thursday",
        body: { type: "document", markdown: "Rates call with Ana, Thursday" },
      });
    });
    await act(async () => {
      await nodeViewStore().writeCaptureDesk(CANVAS, {
        open: { kind: "artifact", nodeId: INBOX, artifactId },
        query: "",
        focused: artifactId,
        caret: 6,
        scrollWriting: 0,
        scrollList: 0,
      });
    });

    await openOnChord();
    expect(document.querySelector(".quick-capture .cm-content")?.textContent).toContain("Rates call with Ana, Thursday");
    // The desk still names it: opening did not turn the desk back into a new capture.
    expect(nodeViewStore().captureDesk(CANVAS)?.open).toEqual({ kind: "artifact", nodeId: INBOX, artifactId });
  });

  it("points the desk at the artifact the first keystroke makes, so a kill reopens the words", async () => {
    await openOnChord();
    await type("Call Ana about rates");

    const desk = nodeViewStore().captureDesk(CANVAS);
    expect(desk?.open.kind).toBe("artifact");
    const [head] = await source.list(CANVAS, INBOX);
    expect(desk?.open).toEqual({ kind: "artifact", nodeId: INBOX, artifactId: head?.artifact.artifactId });
  });
});
