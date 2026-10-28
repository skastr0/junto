// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactLabel } from "../src/shared/artifact-labels";
import type { ArtifactHead } from "../src/shared/resource-ipc";
import {
  ArtifactLabelChips,
  ArtifactLabelFilter,
  addLabel,
  labelOptions,
} from "../src/renderer/components/artifacts/ArtifactLabelChips";
import { labelChoices, labelsInNode, visibleArtifacts } from "../src/renderer/components/artifacts/artifacts-pane-model";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = (...labels: string[]) => labels as unknown as ReadonlyArray<ArtifactLabel>;
const head = (title: string, labels: ReadonlyArray<string>, archived = false, type = "document"): ArtifactHead =>
  ({ artifact: { artifactId: title, title, type, labels, archived } }) as unknown as ArtifactHead;

const entries = [
  head("Release notes", ["project/junto/release", "draft"]),
  head("Web plan", ["project/junto/web"]),
  head("Budget", ["finance"], false, "sheet"),
  head("Old spec", ["project/junto/release"], true),
];
const all = { type: "all", query: "", archived: false, labels: L() } as const;

describe("the sidebar's labels filter", () => {
  it("shows a row only when it holds every picked label, a level matching the labels under it", () => {
    const titles = (labels: ReadonlyArray<ArtifactLabel>) => visibleArtifacts(entries, { ...all, labels }).map((e) => e.artifact.title);
    expect(titles(L("project/junto"))).toEqual(["Release notes", "Web plan"]);
    expect(titles(L("project/junto", "draft"))).toEqual(["Release notes"]);
    expect(titles(L("project/jun"))).toEqual([]);
    expect(titles(L())).toHaveLength(3);
  });

  it("offers the labels in view and a level over two of them, each with the rows picking it shows", () => {
    expect(labelChoices(entries, all)).toEqual([
      { label: "draft", count: 1, picked: false },
      { label: "finance", count: 1, picked: false },
      { label: "project/junto", count: 2, picked: false },
      { label: "project/junto/release", count: 1, picked: false },
      { label: "project/junto/web", count: 1, picked: false },
    ]);
    // A level with one branch shows the same rows as the level under it, so it is not offered.
    expect(labelChoices([head("A", ["a/b/c"])], all).map((c) => c.label)).toEqual(["a/b/c"]);
  });

  it("counts beside the rest of the filter and keeps a pick that matches nothing in view", () => {
    const picked = labelChoices(entries, { ...all, labels: L("draft") });
    expect(picked.find((c) => c.label === "draft")).toEqual({ label: "draft", count: 1, picked: true });
    expect(picked.find((c) => c.label === "finance")?.count).toBe(0);
    const archived = labelChoices(entries, { ...all, archived: true, labels: L("finance") });
    expect(archived.map((c) => [c.label, c.count, c.picked])).toEqual([
      ["finance", 0, true],
      ["project/junto/release", 0, false],
    ]);
  });

  it("completes the header from every label in the node, archived included", () => {
    expect(labelsInNode(entries)).toEqual(["draft", "finance", "project/junto/release", "project/junto/web"]);
  });
});

describe("adding a label", () => {
  it("folds what was typed into the whole next set, sorted", () => {
    expect(addLabel(L("zeta"), "  Alpha ")).toEqual({ labels: ["alpha", "zeta"] });
    expect(addLabel(L("alpha"), "ALPHA")).toBeNull();
    expect(addLabel(L(), "   ")).toBeNull();
  });

  it("says why when the word breaks the rule or the set is full", () => {
    expect(addLabel(L(), "a//b")).toEqual({ refused: expect.stringContaining("Labels take") });
    const full = L(...Array.from({ length: 20 }, (_, i) => `l${String(i).padStart(2, "0")}`));
    expect(addLabel(full, "one more")).toEqual({ refused: "An artifact holds at most 20 labels." });
  });

  it("offers the node's labels not held that contain the query, a new one first", () => {
    const used = L("draft", "project/junto", "review");
    expect(labelOptions(used, L("draft"), "")).toEqual([
      { kind: "used", label: "project/junto" },
      { kind: "used", label: "review" },
    ]);
    expect(labelOptions(used, L(), "Re")).toEqual([
      { kind: "new", label: "re" },
      { kind: "used", label: "review" },
    ]);
    expect(labelOptions(used, L(), "review")).toEqual([{ kind: "used", label: "review" }]);
    expect(labelOptions(used, L(), "/bad")).toEqual([]);
  });
});

let host: HTMLDivElement;
let root: Root;
const render = (node: React.ReactNode) => act(() => root.render(node));
const press = (selector: string) => act(() => host.querySelector<HTMLElement>(selector)?.click());
const field = () => host.querySelector<HTMLInputElement>('[aria-label="Find or add labels"]');
const type = (value: string) =>
  act(() => {
    const input = field()!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const key = (name: string) => act(() => field()?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("header label chips", () => {
  it("removes one chip by sending the rest of the set", () => {
    const onChange = vi.fn(async () => "applied" as const);
    render(<ArtifactLabelChips waiting={false} labels={L("draft", "review")} used={L()} readOnly={false} onChange={onChange} />);
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Labels");
    press('[aria-label="Remove draft"]');
    expect(onChange).toHaveBeenCalledWith(["review"]);
    expect(host.querySelector('[aria-label="Remove draft"]')).toBeNull();
  });

  it("adds a typed label on Enter, focused in the picker, and keeps it open for the next", () => {
    const onChange = vi.fn(async () => "applied" as const);
    render(<ArtifactLabelChips waiting={false} labels={L("draft")} used={L("draft", "review")} readOnly={false} onChange={onChange} />);
    press('[aria-label="Add labels"]');
    expect(document.activeElement).toBe(field());
    type("Project/Junto");
    key("Enter");
    expect(onChange).toHaveBeenCalledWith(["draft", "project/junto"]);
    expect(field()?.value).toBe("");
    expect(host.textContent).toContain("project/junto");
  });

  it("says the rule in place of sending a word that breaks it", () => {
    const onChange = vi.fn(async () => "applied" as const);
    render(<ArtifactLabelChips waiting={false} labels={L()} used={L()} readOnly={false} onChange={onChange} />);
    press('[aria-label="Add labels"]');
    type("a//b");
    key("Enter");
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain("Labels take");
  });

  it("goes back to the ruled set when the write is refused", async () => {
    render(<ArtifactLabelChips waiting={false} labels={L("draft")} used={L()} readOnly={false} onChange={async () => "refused" as const} />);
    await act(async () => host.querySelector<HTMLElement>('[aria-label="Remove draft"]')?.click());
    expect(host.querySelector('[aria-label="Remove draft"]')).not.toBeNull();
  });

  it("goes back to the ruled set when a queued write is refused once it stops waiting", async () => {
    const chips = (waiting: boolean) => (
      <ArtifactLabelChips waiting={waiting} labels={L("draft")} used={L()} readOnly={false} onChange={async () => "queued" as const} />
    );
    render(chips(false));
    await act(async () => host.querySelector<HTMLElement>('[aria-label="Remove draft"]')?.click());
    render(chips(true));
    expect(host.querySelector('[aria-label="Remove draft"]')).toBeNull();
    render(chips(false));
    expect(host.querySelector('[aria-label="Remove draft"]')).not.toBeNull();
  });

  it("keeps a later change shown when an earlier one is refused after it", async () => {
    const rulings: Array<(ruling: "applied" | "refused") => void> = [];
    const onChange = () => new Promise<"applied" | "refused">((resolve) => rulings.push(resolve));
    render(<ArtifactLabelChips waiting={false} labels={L("a", "b", "c")} used={L()} readOnly={false} onChange={onChange} />);
    press('[aria-label="Remove a"]');
    press('[aria-label="Remove b"]');
    await act(async () => rulings[0]?.("refused"));
    expect([...host.querySelectorAll(".artifact-labels__word")].map((w) => w.textContent)).toEqual(["c"]);
    await act(async () => rulings[1]?.("refused"));
    expect([...host.querySelectorAll(".artifact-labels__word")].map((w) => w.textContent)).toEqual(["a", "b", "c"]);
  });

  it("shows three chips and the rest behind a count, and closes on Escape back to the add button", () => {
    render(<ArtifactLabelChips waiting={false} labels={L("a", "b", "c", "d", "e")} used={L()} readOnly={false} onChange={async () => "applied" as const} />);
    expect(host.querySelectorAll(".artifact-labels__chips .artifact-labels__chip")).toHaveLength(3);
    press('[aria-label="2 more labels"]');
    expect(host.querySelectorAll(".artifact-labels__held .artifact-labels__chip")).toHaveLength(5);
    key("Escape");
    expect(field()).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('[aria-label="Add labels"]'));
  });

  it("shows an archived artifact's labels without add or remove, and nothing when it has none", () => {
    render(<ArtifactLabelChips waiting={false} labels={L("draft")} used={L()} readOnly onChange={async () => "applied" as const} />);
    expect(host.textContent).toContain("draft");
    expect(host.querySelector('[aria-label="Add labels"]')).toBeNull();
    expect(host.querySelector('[aria-label^="Remove"]')).toBeNull();
    render(<ArtifactLabelChips waiting={false} labels={L()} used={L()} readOnly onChange={async () => "applied" as const} />);
    expect(host.querySelector('[aria-label="Labels"]')).toBeNull();
  });
});

describe("sidebar label filter row", () => {
  it("toggles a label and clears the picks", () => {
    const onToggle = vi.fn();
    const onClear = vi.fn();
    render(
      <ArtifactLabelFilter
        choices={[
          { label: "draft" as ArtifactLabel, count: 2, picked: true },
          { label: "review" as ArtifactLabel, count: 1, picked: false },
        ]}
        onToggle={onToggle}
        onClear={onClear}
      />,
    );
    const buttons = [...host.querySelectorAll<HTMLButtonElement>('[aria-label="Labels"] button')];
    expect(buttons.map((b) => [b.textContent, b.getAttribute("aria-pressed")])).toEqual([
      ["draft2", "true"],
      ["review1", "false"],
      ["Clear", null],
    ]);
    act(() => buttons[1]?.click());
    expect(onToggle).toHaveBeenCalledWith("review");
    act(() => buttons[2]?.click());
    expect(onClear).toHaveBeenCalled();
  });
});
