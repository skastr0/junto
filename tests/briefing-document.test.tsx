// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { asCanvasName } from "../src/shared/model";
import { RegionBriefingEditor } from "../src/renderer/components/InspectorFields";
import { BriefingSettingsSection } from "../src/renderer/components/settings/BriefingSettingsSection";
import { state$ } from "../src/renderer/lib/state";
import { makeLocalTasksSource, setTasksSource } from "../src/renderer/lib/tasks-source";
import { modelStore } from "../src/renderer/lib/use-model";
import { region } from "./support/model-nodes";
import { settleLazy } from "./support/settle-lazy";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; CodeMirror's measuring asks a range for its boxes.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

/** Each region instruction the editor saved, as (region, text). */
const saves: Array<readonly [string, string | null]> = [];
vi.mock("../src/renderer/lib/mutations", async (original) => ({
  ...(await original<typeof import("../src/renderer/lib/mutations")>()),
  commitCommands: (edit: (canvas: unknown) => unknown) => edit(undefined),
}));
vi.mock("../src/renderer/lib/model-edits", async (original) => ({
  ...(await original<typeof import("../src/renderer/lib/model-edits")>()),
  regionEdited: (_canvas: unknown, regionId: string, patch: { readonly instruction?: string | null }) => {
    saves.push([regionId, patch.instruction ?? null]);
    return [];
  },
}));

const CANVAS = "factory";
const REST = 900;

const seed = (a: string, b: string) =>
  act(() => {
    modelStore.adopt({
      canvas: asCanvasName(CANVAS),
      seq: 0,
      wires: [],
      nodes: [
        region("region-a", { x: 0, y: 0, width: 400, height: 400 }, { instruction: a }),
        region("region-b", { x: 1000, y: 0, width: 400, height: 400 }, { instruction: b }),
      ],
    });
  });

describe("a briefing written as a document", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    saves.length = 0;
    setTasksSource(makeLocalTasksSource());
    state$.canvasName.set(CANVAS);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    delete (window as { junto?: unknown }).junto;
  });

  const draw = async (element: React.ReactElement) => {
    await act(async () => root.render(element));
    await settleLazy();
  };
  const content = () => host.querySelector<HTMLElement>(".cm-content")!;
  const editor = () => EditorView.findFromDOM(host.querySelector<HTMLElement>(".cm-editor")!)!;
  const typeAtEnd = async (text: string) =>
    act(async () => {
      const view = editor();
      const at = view.state.doc.length;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
    });
  const rest = () => act(() => new Promise((resolve) => setTimeout(resolve, REST)));

  it("the app briefing is named, reads as read only while it loads, then opens on the stored text", async () => {
    let answer: (value: { body: string }) => void = () => undefined;
    (window as { junto?: unknown }).junto = {
      appBriefingRead: () => new Promise((resolve) => (answer = resolve)),
      onReferencesChanged: () => () => undefined,
    };
    await draw(<BriefingSettingsSection />);
    expect(content().getAttribute("aria-label")).toBe("App briefing");
    expect(host.querySelector(".live-markdown")!.getAttribute("aria-label")).toBe("App briefing, document");
    expect(content().getAttribute("aria-readonly")).toBe("true");
    await act(async () => answer({ body: "How we work." }));
    expect(content().getAttribute("aria-readonly")).toBe("false");
    expect(editor().state.doc.toString()).toBe("How we work.");
  });

  it("the region briefing is a canvas draft, named, and saves typing when it rests", async () => {
    seed("Alpha.", "Beta.");
    await draw(<RegionBriefingEditor nodeId="region-a" />);
    expect(content().getAttribute("aria-label")).toBe("Region briefing");
    expect(host.querySelector(".live-markdown")!.getAttribute("aria-label")).toBe("Region briefing, document");
    expect(content().closest("[data-focus-owner='canvas-draft']")).not.toBeNull();
    await typeAtEnd(" More.");
    await rest();
    expect(saves).toEqual([["region-a", "Alpha. More."]]);
  });

  it("Escape stops writing and keeps the words", async () => {
    seed("Alpha.", "Beta.");
    await draw(<RegionBriefingEditor nodeId="region-a" />);
    await typeAtEnd(" Kept.");
    await act(async () => {
      content().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(editor().state.doc.toString()).toBe("Alpha. Kept.");
  });

  it("one region's unsaved draft never carries into the next", async () => {
    seed("Alpha.", "Beta.");
    await draw(<RegionBriefingEditor nodeId="region-a" />);
    await typeAtEnd(" Unsaved.");
    await draw(<RegionBriefingEditor nodeId="region-b" />);
    expect(editor().state.doc.toString()).toBe("Beta.");
    await rest();
    // The draft went to its own region as the field closed; B was never written.
    expect(saves).toEqual([["region-a", "Alpha. Unsaved."]]);
  });
});
