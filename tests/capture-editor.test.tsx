// @vitest-environment jsdom
/**
 * Q2 (docs/plans/0.11/11-quick-capture.md): a capture is a document in the
 * Inbox from its first keystroke, titled by its first line until one is
 * typed; its type switches with its words kept, and undo puts it back.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { asCanvasName } from "../src/shared/model";
import { asNodeId } from "../src/shared/physics/schema";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import { mintItemId, type ItemId } from "../src/shared/resource-command";
import { makeLocalArtifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { CaptureEditor, type CaptureOpen, type CaptureRef } from "../src/renderer/components/capture/CaptureEditor";
import { artifacts, region } from "./support/model-nodes";

// jsdom lays nothing out; CodeMirror's measuring asks a range for its boxes.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();
// The picker brings its highlight into view; jsdom has nowhere to scroll it.
Element.prototype.scrollIntoView ??= function scrollIntoView() {};

const CANVAS = "factory";
const INBOX = asNodeId("inbox");
const NODES = [
  region("product", { x: 0, y: 0, width: 1400, height: 1000 }, { label: "Product" }),
  artifacts("inbox", { x: 6000, y: 6000, label: "Inbox" }),
  artifacts("specs", { x: 40, y: 40, label: "Specs" }),
];

let root: Root;
let host: HTMLDivElement;
let release: () => void;
let source: ArtifactsSource;
let refs: Array<CaptureRef | null>;

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
};
const editorView = (): EditorView => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
const typeInto = async (text: string): Promise<void> => {
  const view = editorView();
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input.type" }));
};
const inbox = (): Promise<ReadonlyArray<ArtifactHead>> => source.list(CANVAS, INBOX);
const live = async (): Promise<ReadonlyArray<ArtifactHead>> => (await inbox()).filter((head) => !head.artifact.archived);
const button = (words: string): HTMLButtonElement => [...host.querySelectorAll("button")].find((one) => one.textContent?.includes(words))!;

const mount = async (open: CaptureOpen = { kind: "new", key: 0 }, inboxNode: typeof INBOX | null = INBOX): Promise<void> => {
  await act(async () => root.render(<CaptureEditor canvasName={CANVAS} inbox={inboxNode ?? undefined} open={open} onArtifact={(ref) => refs.push(ref)} />));
  // The Markdown engine loads lazily.
  for (let i = 0; i < 40 && host.querySelector(".cm-editor") === null; i += 1) await settle();
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // jsdom lays nothing out; the sheet only measures.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  release = modelStore.adopt({ canvas: asCanvasName(CANVAS), seq: 0, wires: [], nodes: NODES });
  source = makeLocalArtifactsSource();
  setArtifactsSource(source);
  refs = [];
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  // A measure still scheduled runs now, inside this test, never after it; unmount then destroys the view.
  await act(async () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))));
  act(() => root.unmount());
  host.remove();
  release();
  vi.unstubAllGlobals();
});

describe("a capture", () => {
  it("is a document in the Inbox from its first keystroke, titled by its first line", async () => {
    await mount();
    expect(await inbox()).toEqual([]);
    await typeInto("C");
    await settle();
    const [made] = await inbox();
    expect(made?.artifact).toMatchObject({ type: "document", title: "C", nodeId: "inbox" });
    expect(refs.at(-1)).toEqual({ nodeId: INBOX, artifactId: made!.artifact.artifactId });

    // The rest saves at rest, and the title follows the first line.
    await typeInto("# Call Ana about rates\nand the lease");
    await act(async () => editorView().contentDOM.dispatchEvent(new FocusEvent("blur")));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    await settle();
    const [after] = await inbox();
    expect(after?.body).toEqual({ type: "document", markdown: "# Call Ana about rates\nand the lease" });
    expect(after?.artifact.title).toBe("Call Ana about rates");
  });

  it("is refused, not guessed, with no Inbox", async () => {
    await mount({ kind: "new", key: 0 }, null);
    await typeInto("lost?");
    await settle();
    expect(host.textContent).toContain("Pick an Inbox in Settings first");
  });

  it("switches to a sheet with a row per line, and undo puts the document back", async () => {
    await mount();
    await typeInto("milk\neggs\nbread");
    await settle();
    const [doc] = await inbox();
    const docId = doc!.artifact.artifactId;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    await settle();

    // The type dropdown: open it and pick Sheet.
    const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Type"]')!;
    await act(async () => trigger.click());
    const sheetOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((one) => one.textContent === "Sheet")!;
    await act(async () => sheetOption.click());
    await settle();

    const [sheet] = await live();
    expect(sheet?.artifact.type).toBe("sheet");
    expect(sheet?.body?.type === "sheet" && sheet.body.grid.rows.map((row) => row.cells)).toEqual([{ c1: "milk" }, { c1: "eggs" }, { c1: "bread" }]);
    expect((await inbox()).find((head) => head.artifact.artifactId === docId)?.artifact.archived).toBe(true);

    await act(async () => button("Back to document").click());
    await settle();
    const [back] = await live();
    expect(back?.artifact.artifactId).toBe(docId);
    expect(back?.body).toEqual({ type: "document", markdown: "milk\neggs\nbread" });
  });

  it("edits an artifact in place, its typed title kept over its first line", async () => {
    const id = mintItemId() as ItemId;
    await source.apply(CANVAS, asNodeId("specs"), id, mintItemId() as never, {
      op: "create",
      title: "Release notes",
      body: { type: "document", markdown: "first line" },
    });
    await mount({ kind: "artifact", nodeId: asNodeId("specs"), artifactId: id });
    await typeInto("a new first line");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    await settle();
    const [head] = await source.list(CANVAS, asNodeId("specs"));
    expect(head?.body).toEqual({ type: "document", markdown: "a new first line" });
    expect(head?.artifact.title).toBe("Release notes");
    // Out of the Inbox, the type stays: a switch would make it a new artifact.
    expect(host.querySelector('[aria-label="Type"]')).toBeNull();
  });

  /** The source with a retitle that takes a while to answer, and a restore that can be refused. */
  const slowAndStubborn = (refuseRestore: { on: boolean }): ArtifactsSource => {
    const base = source;
    return {
      ...base,
      apply: async (canvasName, nodeId, itemId, opId, op) => {
        if (op.op === "retitle") await new Promise((resolve) => setTimeout(resolve, 40));
        if (op.op === "restore" && refuseRestore.on) return { kind: "refused", opId, error: { type: "conflict", message: "Not now." } } as never;
        return base.apply(canvasName, nodeId, itemId, opId, op);
      },
    };
  };
  const pickType = async (name: string): Promise<void> => {
    await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Type"]')!.click());
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((one) => one.textContent === name)!;
    await act(async () => option.click());
    await settle();
  };

  it("gives the switched artifact the title just typed, though its retitle has not listed yet", async () => {
    setArtifactsSource(slowAndStubborn({ on: false }));
    await mount();
    await typeInto("milk\neggs");
    await settle();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    await settle();
    const title = host.querySelector<HTMLInputElement>('[aria-label="Title"]')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      set.call(title, "Groceries");
      title.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => title.dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    // Switch at once, before the slow retitle lists.
    await pickType("Sheet");
    await act(async () => new Promise((resolve) => setTimeout(resolve, 100)));
    await settle();
    const [sheet] = await live();
    expect(sheet?.artifact).toMatchObject({ type: "sheet", title: "Groceries" });
  });

  it("undoes a switch restore-first: a refused restore leaves the switch live and Back still works", async () => {
    const refuse = { on: true };
    setArtifactsSource(slowAndStubborn(refuse));
    await mount();
    await typeInto("milk\neggs");
    await settle();
    await act(async () => new Promise((resolve) => setTimeout(resolve, 900)));
    await settle();
    await pickType("Sheet");
    const [sheet] = await live();
    expect(sheet?.artifact.type).toBe("sheet");

    await act(async () => button("Back to document").click());
    await settle();
    // Refused: nothing changed, the sheet is still live and Back is still offered.
    expect((await live()).map((head) => head.artifact.type)).toEqual(["sheet"]);
    expect(button("Back to document")).toBeDefined();

    refuse.on = false;
    await act(async () => button("Back to document").click());
    await settle();
    expect((await live()).map((head) => head.artifact.type)).toEqual(["document"]);
  });

  it("keeps its editor and its title through Move to, until the new node lists it", async () => {
    await mount();
    await typeInto("Rates for the lease");
    await settle();
    const before = editorView();
    await act(async () => button("Move to").click());
    await settle();
    const specs = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((one) => one.textContent?.includes("Specs"))!;
    await act(async () => specs.click());
    const move = [...document.querySelectorAll<HTMLButtonElement>("button")].find((one) => one.textContent === "Move")!;
    await act(async () => move.click());
    // The first render after the move, before the new node's list is read again.
    expect(host.querySelector<HTMLInputElement>('[aria-label="Title"]')?.value).toBe("Rates for the lease");
    expect(editorView()).toBe(before);
    await settle();
    expect((await source.list(CANVAS, asNodeId("specs"))).map((head) => head.artifact.title)).toEqual(["Rates for the lease"]);
    expect(refs.at(-1)?.nodeId).toBe("specs");
  });
});

