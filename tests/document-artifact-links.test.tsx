// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { artifactLink } from "../src/shared/artifact-link";
import type { MentionOf } from "../src/shared/mention";
import type { NodeKind } from "../src/shared/model/kinds";
import { asNodeId } from "../src/shared/physics/schema";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import type { ItemId } from "../src/shared/work-ids";
import type { LinkableArtifact } from "../src/renderer/lib/artifact-link-draft";
import { artifactsSource, setArtifactsSource, type ArtifactsSource } from "../src/renderer/lib/artifacts-source";
import { mentionPicker, pickerQueryAt, type PickerLinks } from "../src/renderer/components/artifacts/mention-picker";

vi.mock("../src/renderer/lib/mention-open", async (load) => ({
  ...(await load<typeof import("../src/renderer/lib/mention-open")>()),
  openMention: () => undefined,
}));
const { DocumentMentionChip } = await import("../src/renderer/components/artifacts/DocumentMentionChip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const NODE = asNodeId("artifacts-home");
const OTHER = asNodeId("artifacts-other");
const ref = (nodeId: typeof NODE, id: string): MentionOf<"artifact"> => ({ kind: "artifact", nodeId, artifactId: id as ItemId });
const PLAN: LinkableArtifact = { ref: ref(NODE, "01M5ZC0000000000000000000B"), title: "Launch plan", type: "document" };
const BUDGET: LinkableArtifact = { ref: ref(OTHER, "01M5ZC0000000000000000000C"), title: "Launch budget", type: "sheet", place: "Finance" };
const NEW = ref(NODE, "01M5ZC0000000000000000000D");

describe("where a [[ link can be typed", () => {
  const stateAt = (doc: string, caret = doc.length) =>
    EditorState.create({ doc, selection: EditorSelection.cursor(caret), extensions: [markdown({ base: markdownLanguage })] });

  it("[[ and the title typed so far, spaces included", () => {
    expect(pickerQueryAt(stateAt("See [[Launch pl"))).toEqual({ trigger: "[[", from: 4, to: 15, query: "Launch pl" });
    expect(pickerQueryAt(stateAt("[["))).toEqual({ trigger: "[[", from: 0, to: 2, query: "" });
  });

  it("never in code, nor once the brackets close", () => {
    expect(pickerQueryAt(stateAt("run `[[x` now", 8))).toBeNull();
    expect(pickerQueryAt(stateAt("[[Launch]] "))).toBeNull();
  });
});

describe("the [[ list in a live document", () => {
  let host: HTMLDivElement;
  let view: EditorView;
  let links: PickerLinks | undefined;
  let created: string[];
  let finish: (made: MentionOf<"artifact"> | null) => void;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    created = [];
    links = {
      artifacts: [PLAN, BUDGET],
      create: (title) => {
        created.push(title);
        return new Promise((resolve) => (finish = resolve));
      },
    };
    view = new EditorView({
      parent: host,
      state: EditorState.create({
        extensions: [markdown({ base: markdownLanguage }), mentionPicker(() => ({ canvasName: "factory", candidates: [], links }))],
      }),
    });
    view.contentDOM.focus();
  });

  afterEach(async () => {
    await act(async () => view.destroy());
    host.remove();
  });

  const type = async (text: string) => {
    await act(async () => {
      const at = view.state.selection.main.head;
      view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, userEvent: "input.type" });
    });
  };
  const press = async (key: string) => {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => view.contentDOM.dispatchEvent(event));
    return event;
  };
  const picker = () => host.querySelector<HTMLElement>("[data-testid=document-mention-picker]");
  const rows = () => [...host.querySelectorAll<HTMLElement>("[role=option]")].map((option) => option.textContent);
  const live = () => host.querySelector<HTMLElement>("[data-testid=document-mention-announcer]")?.textContent;

  it("offers the artifacts in reach by title, another node's with its place, and names the list", async () => {
    await type("See [[");
    expect(picker()?.hidden).toBe(false);
    expect(host.querySelector("[role=listbox]")?.getAttribute("aria-label")).toBe("Artifacts to link");
    expect(rows()).toEqual(["Launch planDocument", "Launch budgetFinanceSheet"]);
    expect(view.contentDOM.getAttribute("aria-activedescendant")).toBe(host.querySelector("[aria-selected=true]")?.id);
    await type("launch b");
    expect(rows()).toEqual(["Launch budgetFinanceSheet", "Create document launch bNew"]);
    expect(live()).toBe("2 matches");
  });

  it("Enter writes the [[Title]] link by id, and says so", async () => {
    await type("See [[plan");
    expect(rows()).toEqual(["Launch planDocument", "Create document planNew"]);
    await press("Enter");
    expect(view.state.doc.toString()).toBe(`See ${artifactLink(PLAN.ref, "Launch plan", "factory")} `);
    expect(picker()).toBeNull();
    expect(live()).toBe("Linked Launch plan");
  });

  it("a title that matches nothing creates the document on its press, then links it where [[ was", async () => {
    await type("See [[Q3 review");
    expect(rows()).toEqual(["Create document Q3 reviewNew"]);
    await press("Enter");
    expect(created).toEqual(["Q3 review"]);
    // Nothing is linked until the document exists; the list closes meanwhile and typing goes on.
    expect(view.state.doc.toString()).toBe("See [[Q3 review");
    expect(picker()).toBeNull();
    expect(live()).toBe("Creating Q3 review");
    await act(async () => view.dispatch({ changes: { from: 0, insert: "> " } }));
    await act(async () => finish(NEW));
    expect(view.state.doc.toString()).toBe(`> See ${artifactLink(NEW, "Q3 review", "factory")} `);
    expect(live()).toBe("Created and linked Q3 review");
  });

  it("a create that fails leaves the text as typed, and says so", async () => {
    await type("[[Q3");
    await press("Enter");
    await act(async () => finish(null));
    expect(view.state.doc.toString()).toBe("[[Q3");
    expect(live()).toBe("Q3 could not be created");
  });

  it("without a create, no create row; without links, [[ is only brackets", async () => {
    links = { artifacts: [PLAN] };
    await type("[[nothing");
    expect(rows()).toEqual([]);
    expect(host.querySelector("[data-testid=mention-empty]")?.textContent).toBe("No matches");
    links = undefined;
    await type(" [[");
    expect(picker()?.hidden ?? true).toBe(true);
    expect(view.contentDOM.hasAttribute("aria-controls")).toBe(false);
  });
});

describe("a [[ link drawn in a document", () => {
  let host: HTMLDivElement;
  let root: Root;
  const original = artifactsSource();
  const kinds: Record<string, NodeKind> = { [NODE]: "artifacts" };
  const href = `junto://canvas/factory?node=${NODE}&item=${PLAN.ref.artifactId}`;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    setArtifactsSource({
      ...original,
      list: async () => [{ artifact: { artifactId: PLAN.ref.artifactId, title: "Launch plan, final", type: "document", archived: false } } as unknown as ArtifactHead],
      onChanged: () => () => undefined,
    } as unknown as ArtifactsSource);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    setArtifactsSource(original);
  });

  it("says the artifact's title now, not the one it was written with, without brackets", async () => {
    await act(async () => root.render(<DocumentMentionChip href={href} label="\[\[Launch plan\]\]" nodeKindOf={(id) => kinds[id]} />));
    const chip = host.querySelector<HTMLElement>("[data-testid=document-mention-chip]")!;
    expect(chip.dataset.kind).toBe("artifact");
    expect(chip.querySelector(".resource-chip__label")?.textContent).toBe("Launch plan, final");
    expect(chip.textContent).toContain(", Document");
  });

  it("a # mention of the same artifact keeps the words it was written with", async () => {
    await act(async () => root.render(<DocumentMentionChip href={href} label="#Launch plan" nodeKindOf={(id) => kinds[id]} />));
    expect(host.querySelector(".resource-chip__label")?.textContent).toBe("Launch plan");
  });

  it("an artifact that is gone keeps its written title, unavailable", async () => {
    await act(async () => root.render(<DocumentMentionChip href={href} label="\[\[Launch plan\]\]" nodeKindOf={() => undefined} />));
    const chip = host.querySelector<HTMLElement>("[data-testid=document-mention-chip]")!;
    expect(chip.dataset.missing).toBe("true");
    expect(chip.textContent).toContain("Launch plan");
    expect(chip.textContent).not.toContain("[[");
  });
});
