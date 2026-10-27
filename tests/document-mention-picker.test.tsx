// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { NodeKind } from "../src/shared/model/kinds";
import { asNodeId, type NodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import type { MentionCandidate } from "../src/renderer/lib/mention-draft";
import { mentionPicker, mentionSourceChanged, pickerQueryAt } from "../src/renderer/components/artifacts/mention-picker";

const opened = vi.hoisted(() => [] as unknown[]);
vi.mock("../src/renderer/lib/mention-open", async (load) => ({
  ...(await load<typeof import("../src/renderer/lib/mention-open")>()),
  openMention: (ref: unknown) => opened.push(ref),
}));
const { DocumentMentionChip } = await import("../src/renderer/components/artifacts/DocumentMentionChip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom lays nothing out; CodeMirror's measuring asks a range for its boxes.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

const ITEM = "01M5ESSJRFWT6RVS5HMWMGJXGD" as ItemId;
const candidates: ReadonlyArray<MentionCandidate> = [
  { ref: { kind: "seat", nodeId: asNodeId("agent-feed") }, label: "@product-feed" },
  { ref: { kind: "seat", nodeId: asNodeId("agent-lead") }, label: "@product-lead", note: "not running" },
  { ref: { kind: "task", nodeId: asNodeId("task-board"), taskId: ITEM }, label: "#42 fix tabs" },
];

const stateAt = (doc: string, caret = doc.length): EditorState => {
  const state = EditorState.create({
    doc,
    selection: EditorSelection.cursor(caret),
    extensions: [markdown({ base: markdownLanguage })],
  });
  ensureSyntaxTree(state, state.doc.length, 5_000);
  return state;
};

describe("where a mention can be typed", () => {
  it("an @ or # after a space or at a line's start, with what follows it", () => {
    expect(pickerQueryAt(stateAt("Ask @prod"))).toEqual({ trigger: "@", from: 4, to: 9, query: "prod" });
    expect(pickerQueryAt(stateAt("@"))).toEqual({ trigger: "@", from: 0, to: 1, query: "" });
    expect(pickerQueryAt(stateAt("see #4"))).toEqual({ trigger: "#", from: 4, to: 6, query: "4" });
    expect(pickerQueryAt(stateAt("- #42"))).toEqual({ trigger: "#", from: 2, to: 5, query: "42" });
  });

  it("a # that begins its line is a heading until a letter follows", () => {
    expect(pickerQueryAt(stateAt("#"))).toBeNull();
    expect(pickerQueryAt(stateAt("intro\n  #"))).toBeNull();
    expect(pickerQueryAt(stateAt("# Title"))).toBeNull();
    expect(pickerQueryAt(stateAt("#fix"))).toEqual({ trigger: "#", from: 0, to: 4, query: "fix" });
  });

  it("never in code, a link, an address, a word or a selection", () => {
    expect(pickerQueryAt(stateAt("run `npm @sc` now", 12))).toBeNull();
    expect(pickerQueryAt(stateAt("```\n@here\n```", 9))).toBeNull();
    // A fence just past what the first parse covers (3,000 characters) is still code; small, so the parse stays far inside its budget under load.
    const long = `${"para\n\n".repeat(600)}\`\`\`\n@here`;
    const cold = EditorState.create({ doc: long, selection: EditorSelection.cursor(long.length), extensions: [markdown({ base: markdownLanguage })] });
    expect(syntaxTree(cold).length).toBeLessThan(long.length);
    expect(pickerQueryAt(cold)).toBeNull();
    expect(pickerQueryAt(stateAt("[see @there](https://example.com)", 11))).toBeNull();
    expect(pickerQueryAt(stateAt("mail me@host"))).toBeNull();
    const selected = stateAt("Ask @prod").update({ selection: EditorSelection.range(4, 9) }).state;
    expect(pickerQueryAt(selected)).toBeNull();
    expect(pickerQueryAt(EditorState.create({ doc: "@", selection: EditorSelection.cursor(1), extensions: [EditorState.readOnly.of(true)] }))).toBeNull();
  });
});

describe("a caret past what is parsed", () => {
  const far = `${"para\n\n".repeat(600)}Ask @he`;
  const coldAt = (doc: string) =>
    EditorState.create({ doc, selection: EditorSelection.cursor(doc.length), extensions: [markdown({ base: markdownLanguage })] });

  it("waits closed while the parse has not reached the caret, then offers once it has", () => {
    const state = coldAt(far);
    expect(pickerQueryAt(state, 0)).toBeNull();
    ensureSyntaxTree(state, state.doc.length, 5_000);
    expect(pickerQueryAt(state, 0)).toEqual({ trigger: "@", from: far.length - 3, to: far.length, query: "he" });
  });

  it("never guesses inside an unparsed fence", () => {
    const fenced = `${"para\n\n".repeat(600)}\`\`\`\n@here`;
    const state = coldAt(fenced);
    expect(pickerQueryAt(state, 0)).toBeNull();
    ensureSyntaxTree(state, state.doc.length, 5_000);
    expect(pickerQueryAt(state, 0)).toBeNull();
  });
});

describe("the @ and # list in a live document", () => {
  let host: HTMLDivElement;
  let view: EditorView;
  let source: { canvasName: string; candidates: ReadonlyArray<MentionCandidate> };
  let changes: Transaction[];

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    source = { canvasName: "factory", candidates };
    changes = [];
    view = new EditorView({
      parent: host,
      state: EditorState.create({ extensions: [markdown({ base: markdownLanguage }), mentionPicker(() => source)] }),
      dispatchTransactions: (trs, editor) => {
        changes.push(...trs.filter((tr) => tr.docChanged));
        editor.update(trs);
      },
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
  const options = () => [...host.querySelectorAll<HTMLElement>("[data-testid=mention-option]")].map((option) => option.textContent);
  const live = () => host.querySelector<HTMLElement>("[data-testid=document-mention-announcer]")?.textContent;

  it("opens on @ with the trigger's candidates, filtered as typed, and names the list from the document", async () => {
    await type("Ask @");
    expect(picker()?.hidden).toBe(false);
    expect(options()).toEqual(["@product-feedSeat", "@product-leadSeatnot running"]);
    expect(view.contentDOM.getAttribute("aria-controls")).toBe(host.querySelector("[role=listbox]")?.id);
    expect(view.contentDOM.getAttribute("aria-activedescendant")).toBe(host.querySelector("[aria-selected=true]")?.id);
    expect(live()).toBe("2 matches");
    await type("lead");
    expect(options()).toEqual(["@product-leadSeatnot running"]);
    await type("x");
    expect(options()).toEqual([]);
    expect(host.querySelector("[data-testid=mention-empty]")?.textContent).toBe("No matches");
  });

  it("Down then Enter writes the highlighted mention as its link and one space, as one input.mention change", async () => {
    await type("Ask @pro");
    await press("ArrowDown");
    expect(host.querySelector("[aria-selected=true]")?.textContent).toContain("@product-lead");
    const enter = await press("Enter");
    expect(enter.defaultPrevented).toBe(true);
    const link = "[@product-lead](junto://canvas/factory?node=agent-lead)";
    expect(view.state.doc.toString()).toBe(`Ask ${link} `);
    expect(view.state.selection.main.head).toBe(`Ask ${link} `.length);
    expect(changes.at(-1)?.isUserEvent("input.mention")).toBe(true);
    expect(picker()).toBeNull();
    expect(live()).toBe("Mentioned @product-lead");
  });

  it("# offers tasks and artifacts, and Tab picks with the item in the link", async () => {
    await type("see #fix");
    expect(options()).toEqual(["#42 fix tabsTask"]);
    await press("Tab");
    expect(view.state.doc.toString()).toBe(`see [#42 fix tabs](junto://canvas/factory?node=task-board&item=${ITEM}) `);
  });

  it("a click on an option picks it, keeping the caret in the document", async () => {
    await type("@");
    const option = host.querySelectorAll<HTMLElement>("[data-testid=mention-option]")[0]!;
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    option.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    await act(async () => option.click());
    expect(view.state.doc.toString()).toBe("[@product-feed](junto://canvas/factory?node=agent-feed) ");
  });

  it("Escape closes the list for that query while it lasts; a new trigger opens it; with no list the keys stay the document's", async () => {
    await type("@");
    const escape = await press("Escape");
    expect(escape.defaultPrevented).toBe(true);
    expect(picker()).toBeNull();
    await type("pro");
    expect(picker()).toBeNull();
    expect((await press("Enter")).defaultPrevented).toBe(false);
    await type(" and @");
    expect(picker()?.hidden).toBe(false);
  });

  it("a dismissal follows its query when text before it changes", async () => {
    await type("Ask @");
    await press("Escape");
    await act(async () => view.dispatch({ changes: { from: 0, insert: "Please " }, userEvent: "input.type" }));
    await type("p");
    expect(picker()).toBeNull();
  });

  it("stays shut for a trigger with nothing to offer, and offers late candidates as they arrive", async () => {
    source = { canvasName: "factory", candidates: candidates.filter((candidate) => candidate.ref.kind === "task") };
    await type("@");
    expect(picker()?.hidden).toBe(true);
    expect((await press("Enter")).defaultPrevented).toBe(false);
    source = { canvasName: "factory", candidates };
    await act(async () => mentionSourceChanged(view));
    expect(picker()?.hidden).toBe(false);
  });

  it("shows no empty box before its rows are drawn", async () => {
    view.dispatch({ changes: { from: 0, insert: "@" }, selection: { anchor: 1 }, userEvent: "input.type" });
    expect(picker()?.hidden).toBe(true);
    await act(async () => undefined);
    expect(picker()?.hidden).toBe(false);
    expect(options().length).toBe(2);
  });
});

describe("a mention link drawn in a document", () => {
  let host: HTMLDivElement;
  let root: Root;
  const KINDS: Record<string, NodeKind> = { s: "agent", t: "task" };
  const kindOf = (id: NodeId): NodeKind | undefined => KINDS[id];
  const href = (node: string, item?: string) => `junto://canvas/factory?node=${node}${item === undefined ? "" : `&item=${item}`}`;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    opened.length = 0;
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it("a seat is its chip, a click opens it, and the press claims neither focus nor caret", () => {
    act(() => root.render(<DocumentMentionChip href={href("s")} label="@product-feed" nodeKindOf={kindOf} />));
    const chip = host.querySelector<HTMLButtonElement>("[data-testid=document-mention-chip]")!;
    expect(chip.dataset.kind).toBe("seat");
    expect(chip.textContent).toContain("@product-feed");
    expect(chip.tabIndex).toBe(-1);
    const down = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
    chip.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    act(() => chip.click());
    expect(opened).toEqual([{ kind: "seat", nodeId: "s" }]);
  });

  it("a task shows its number; one that is gone is unavailable and does not open", () => {
    act(() =>
      root.render(
        <>
          <DocumentMentionChip href={href("t", ITEM)} label="#42 fix tabs" nodeKindOf={kindOf} />
          <DocumentMentionChip href={href("gone", ITEM)} label="#7 old" nodeKindOf={kindOf} />
          <DocumentMentionChip href={href("gone")} label="@left" nodeKindOf={kindOf} />
        </>,
      ),
    );
    const [task, goneTask, goneSeat] = [...host.querySelectorAll<HTMLElement>("[data-testid=document-mention-chip]")];
    expect(task?.querySelector(".resource-chip__number")?.textContent).toBe("#42");
    expect(goneTask?.dataset.missing).toBe("true");
    expect(goneTask?.tagName).toBe("SPAN");
    expect(goneSeat?.tagName).toBe("DEL");
    expect(goneSeat?.textContent).toBe("left");
  });

  it("a link that is not a mention stays its words", () => {
    act(() => root.render(<DocumentMentionChip href="https://example.com" label="site" nodeKindOf={kindOf} />));
    expect(host.textContent).toBe("site");
    expect(host.querySelector("[data-testid=document-mention-chip]")).toBeNull();
  });
});
