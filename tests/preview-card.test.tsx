// @vitest-environment jsdom
/**
 * The preview card: a Junto thing embedded in an artifact. Pure (same face,
 * same card), one height for every kind so a document block never jumps, and
 * opening is the title's in a block (a press elsewhere reaches the editor)
 * and the whole card's in a pad. Plus the face derivations and the one link
 * grammar the document and the pad parse.
 */
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactBody } from "../src/shared/artifact";
import { formatNodeRef } from "../src/shared/node-ref";
import { PreviewCard, type PreviewCardProps } from "../src/renderer/components/embeds/PreviewCard";
import {
  artifactFirstLines,
  parsePreviewLink,
  taskKindState,
  taskLedgerOf,
  type PreviewCardFace,
} from "../src/renderer/lib/preview-face";
import { SeatUrgency } from "../src/shared/wire/urgency";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no 2D context; the ring's atlas falls back to drawing without one.
vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);

const S = SeatUrgency.group;
const NODE = "agent-01M46TX8WR2Q4YGKZ6NFW4GTG8";
const ITEM = "01M5Y9Q544EFBXQMPY7WCNVWMT";

const FACES: ReadonlyArray<PreviewCardFace> = [
  { kind: "task", id: ITEM, number: 42 as never, title: "Fix tabs", state: "working", assignee: { id: NODE, name: "builder", harness: "claude" }, ledger: { finished: 2, open: 1, asks: 0, stuck: 0, backlog: 0 } },
  { kind: "seat", id: NODE, name: "planner", harness: "codex", state: S.waiting, line: "permission to run bun test" },
  { kind: "artifact", id: ITEM, type: "document", title: "Plan", version: 3, lines: ["Ship Friday", "Freeze copy Wednesday"] },
  { kind: "page", id: NODE, title: "docs.example.com", url: "https://docs.example.com/a", state: S.resting },
  { kind: "missing", label: "Old plan", reason: "gone", of: "artifact" },
  { kind: "missing", label: "#7 Tabs", reason: "loading", of: "task" },
];

const html = (props: PreviewCardProps) => renderToStaticMarkup(<PreviewCard {...props} />);

describe("PreviewCard, drawn", () => {
  it("draws the same markup for the same face", () => {
    for (const face of FACES) expect(html(face)).toBe(html({ ...face }));
  });

  it("every kind and load state is one block, the document's fixed height", () => {
    for (const face of FACES) expect(html(face)).toMatch(/class="preview-card" data-testid="preview-card" data-size="block"/);
  });

  it("says each kind's name and lines", () => {
    const [task, seat, artifact, page, gone, loading] = FACES.map((face) => html(face));
    expect(task).toContain("#42 Fix tabs");
    expect(task).toContain("Working");
    expect(task).toContain("builder");
    expect(seat).toContain("planner");
    expect(seat).toContain("needs you");
    expect(seat).toContain("permission to run bun test");
    expect(artifact).toContain("Plan");
    expect(artifact).toContain("v3");
    expect(artifact).toContain("Ship Friday");
    expect(artifact).toContain("Freeze copy Wednesday");
    expect(page).toContain("https://docs.example.com/a");
    expect(gone).toContain("Old plan");
    expect(gone).toContain("gone, or out of reach");
    expect(gone).toContain('data-reason="gone"');
    expect(loading).toContain('data-reason="loading"');
  });

  it("a task with nobody on it says so", () => {
    expect(html({ kind: "task", id: ITEM, title: "Spare", state: "backlog" })).toContain("unassigned");
  });

  it("without onOpen nothing on it opens or takes focus", () => {
    for (const face of FACES) {
      for (const size of ["block", "card"] as const) {
        const out = html({ ...face, size });
        expect(out).not.toContain("<button");
        expect(out).not.toContain("tabindex");
      }
    }
  });
});

describe("PreviewCard, opening", () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });
  const mount = (props: PreviewCardProps) => act(() => root.render(<PreviewCard {...props} />));
  const card = () => host.querySelector<HTMLElement>('[data-testid="preview-card"]')!;

  it("in a block the title opens it, and a press on the body reaches the host untouched", () => {
    const onOpen = vi.fn();
    const hostClick = vi.fn();
    host.addEventListener("click", hostClick);
    mount({ ...FACES[2]!, onOpen });
    expect(card().getAttribute("role")).toBeNull();
    expect(card().getAttribute("tabindex")).toBeNull();
    act(() => card().querySelector<HTMLElement>(".preview-card__row")!.click());
    expect(onOpen).not.toHaveBeenCalled();
    expect(hostClick).toHaveBeenCalledTimes(1);
    act(() => host.querySelector<HTMLButtonElement>('[data-testid="preview-card-open"]')!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(card());
  });

  it("as a pad card a click anywhere opens it, and Enter does from the keyboard", () => {
    const onOpen = vi.fn();
    mount({ ...FACES[0]!, size: "card", onOpen });
    expect(host.querySelector("button")).toBeNull();
    act(() => card().querySelector<HTMLElement>(".preview-card__name")!.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
    act(() => card().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(card().getAttribute("data-size")).toBe("card");
  });
});

describe("preview faces", () => {
  it("a task's state is said as the seat's ring says it", () => {
    expect(taskKindState("working")).toBe(S.working);
    expect(taskKindState("input-required")).toBe(S.waiting);
    expect(taskKindState("in-review")).toBe(S.review);
    expect(taskKindState("done")).toBe(S.done);
    expect(taskKindState("canceled")).toBe(S.offline);
    expect(taskKindState("backlog")).toBe(S.resting);
  });

  it("a task's ledger counts its earlier layers finished and where it stands now", () => {
    const layers = [{}, {}] as never;
    expect(taskLedgerOf({ layers, current: { state: "input-required" } as never })).toEqual({ finished: 2, open: 0, asks: 1, stuck: 0, backlog: 0 });
    expect(taskLedgerOf({ layers, current: { state: "done" } as never })).toEqual({ finished: 3, open: 0, asks: 0, stuck: 0, backlog: 0 });
  });

  it("a document's first lines are its words, markers, blanks and rules off", () => {
    const body: ArtifactBody = { type: "document", markdown: "# Plan\n\n---\n- **Ship** [Friday](https://x.y)\n> later" };
    expect(artifactFirstLines(body)).toEqual(["Plan", "Ship Friday"]);
  });

  it("a sheet says its columns, then its first row", () => {
    const body = { type: "sheet", grid: { columns: [{ id: "c1", name: "Seat" }, { id: "c2", name: "Task" }], rows: [{ id: "r1", cells: { c1: "builder", c2: "#42" } }] } } as unknown as ArtifactBody;
    expect(artifactFirstLines(body)).toEqual(["Seat, Task", "builder, #42"]);
  });
});

describe("parsePreviewLink", () => {
  const href = formatNodeRef({ canvasName: "factory", nodeId: NODE });
  const itemHref = `${href}&item=${ITEM}`;

  it("reads a bare href, a mention link and an embed alike", () => {
    expect(parsePreviewLink(href)).toEqual({ target: { nodeId: NODE }, href });
    expect(parsePreviewLink(`[@planner](${href})`)).toEqual({ target: { nodeId: NODE }, href, label: "@planner" });
    expect(parsePreviewLink(`  ![#42 Fix \\[tabs\\]](${itemHref})\n`)).toEqual({ target: { nodeId: NODE, item: ITEM }, href: itemHref, label: "#42 Fix [tabs]" });
  });

  it("a web link or plain text is not a Junto thing", () => {
    expect(parsePreviewLink("https://example.com")).toBeUndefined();
    expect(parsePreviewLink("[x](https://example.com)")).toBeUndefined();
    expect(parsePreviewLink("hello")).toBeUndefined();
  });
});
