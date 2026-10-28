// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArtifactLabel } from "../src/shared/artifact-labels";
import { ArtifactLabelChips, ArtifactLabelFilter } from "../src/renderer/components/artifacts/ArtifactLabelChips";
import {
  type ArtifactLabelColour,
  type LabelColours,
  labelColoursMap,
  labelColourWords,
  useLabelColours,
} from "../src/renderer/lib/artifact-label-colours";
import { makeLocalArtifactsSource, setArtifactsSource } from "../src/renderer/lib/artifacts-source";
import type { ArtifactLabelColours } from "../src/shared/artifact-labels";
import type { NodeId } from "../src/shared/physics/schema";
import type { ResourceApplyOutcome } from "../src/shared/resource-ipc";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const L = (...labels: string[]) => labels as unknown as ReadonlyArray<ArtifactLabel>;
const unread = async () => undefined;
const coloursOf = (held: Record<string, ArtifactLabelColour>, setColour = vi.fn()): LabelColours => ({
  colourOf: (label) => held[label] ?? null,
  setColour,
});

let host: HTMLDivElement;
let root: Root;
const render = (node: React.ReactNode) => act(() => root.render(node));
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
    unobserve() {}
  } as unknown as typeof ResizeObserver;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("label colours in the header", () => {
  it("draws a chip in its colour and names the colour in words", () => {
    render(
      <ArtifactLabelChips
        readRuled={unread}
        waiting={false}
        labels={L("draft", "review")}
        used={L()}
        readOnly={false}
        onChange={async () => "applied" as const}
        colours={coloursOf({ draft: "blue" })}
      />,
    );
    const chips = [...host.querySelectorAll<HTMLElement>(".artifact-labels__chip")];
    expect(chips.map((chip) => chip.dataset.labelColour)).toEqual(["blue", undefined]);
    expect(host.querySelector('[aria-label="draft, blue"]')?.getAttribute("aria-haspopup")).toBe("menu");
    expect(host.querySelector('[aria-label="review, no colour"]')).not.toBeNull();
  });

  it("opens the swatch menu on the chip's word, the label's colour checked, and sets the one picked", () => {
    const setColour = vi.fn();
    render(
      <ArtifactLabelChips
        readRuled={unread}
        waiting={false}
        labels={L("draft")}
        used={L()}
        readOnly={false}
        onChange={async () => "applied" as const}
        colours={coloursOf({ draft: "blue" }, setColour)}
      />,
    );
    const word = host.querySelector<HTMLButtonElement>('[aria-label="draft, blue"]')!;
    act(() => word.click());
    expect(word.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="menu"]')?.getAttribute("aria-label")).toBe("Colour for draft");
    expect(items().map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([
      ["No colour", "false"],
      ["Red", "false"],
      ["Orange", "false"],
      ["Yellow", "false"],
      ["Green", "false"],
      ["Teal", "false"],
      ["Blue", "true"],
      ["Purple", "false"],
      ["Pink", "false"],
    ]);
    // The checked one is the menu's one tab stop.
    expect(items().filter((item) => item.tabIndex === 0).map((item) => item.textContent)).toEqual(["Blue"]);
    act(() => items()[4]?.click());
    expect(setColour).toHaveBeenCalledWith("draft", "green");
    expect(document.querySelector('[role="menu"]')).toBeNull();
    act(() => word.click());
    act(() => items()[0]?.click());
    expect(setColour).toHaveBeenLastCalledWith("draft", null);
  });

  it("moves through the menu with the arrows, Home and End", () => {
    render(
      <ArtifactLabelChips
        readRuled={unread}
        waiting={false}
        labels={L("draft")}
        used={L()}
        readOnly={false}
        onChange={async () => "applied" as const}
        colours={coloursOf({})}
      />,
    );
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="draft, no colour"]')?.click());
    act(() => items()[0]?.focus());
    const key = (name: string) =>
      act(() => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })));
    key("ArrowDown");
    expect(document.activeElement?.textContent).toBe("Red");
    key("ArrowUp");
    key("ArrowUp");
    expect(document.activeElement?.textContent).toBe("Pink");
    key("Home");
    expect(document.activeElement?.textContent).toBe("No colour");
    key("End");
    expect(document.activeElement?.textContent).toBe("Pink");
  });

  it("draws an archived artifact's chips in colour without a menu", () => {
    render(
      <ArtifactLabelChips
        readRuled={unread}
        waiting={false}
        labels={L("draft")}
        used={L()}
        readOnly
        onChange={async () => "applied" as const}
        colours={coloursOf({ draft: "red" })}
      />,
    );
    expect(host.querySelector<HTMLElement>(".artifact-labels__chip")?.dataset.labelColour).toBe("red");
    expect(host.querySelector('[aria-haspopup="menu"]')).toBeNull();
  });
});

describe("label colours in the sidebar", () => {
  it("draws each toggle in its colour, with a swatch beside it that opens the menu", () => {
    const setColour = vi.fn();
    render(
      <ArtifactLabelFilter
        choices={[
          { label: "draft" as ArtifactLabel, count: 2, picked: true },
          { label: "review" as ArtifactLabel, count: 1, picked: false },
        ]}
        onToggle={() => {}}
        onClear={() => {}}
        colours={coloursOf({ draft: "teal" }, setColour)}
      />,
    );
    const pairs = [...host.querySelectorAll<HTMLElement>(".artifacts-filter__label-pair")];
    expect(pairs.map((pair) => pair.dataset.labelColour)).toEqual(["teal", undefined]);
    const swatch = host.querySelector<HTMLButtonElement>('[aria-label="Colour for review, no colour"]')!;
    act(() => swatch.click());
    expect(swatch.getAttribute("aria-expanded")).toBe("true");
    act(() => items().find((item) => item.textContent === "Pink")?.click());
    expect(setColour).toHaveBeenCalledWith("review", "pink");
  });
});

describe("the node's label colours", () => {
  let seen: LabelColours;
  const rulings: ResourceApplyOutcome["kind"][] = [];
  function Probe({ node }: { readonly node: string }) {
    seen = useLabelColours("c", node as NodeId, (outcome) => rulings.push(outcome.kind));
    return <span data-colour={seen.colourOf("draft" as ArtifactLabel) ?? "none"} />;
  }
  const shown = () => [...host.querySelectorAll<HTMLElement>("[data-colour]")].map((span) => span.dataset.colour);

  it("reads them per node from the source, sets one by the node op, and clears it", async () => {
    setArtifactsSource(makeLocalArtifactsSource());
    await act(async () =>
      root.render(
        <>
          <Probe node="colour-a" />
          <Probe node="colour-b" />
        </>,
      ),
    );
    await act(async () => seen.setColour("draft" as ArtifactLabel, "purple"));
    expect(shown()).toEqual(["none", "purple"]);
    expect(rulings).toEqual(["applied"]);
    await act(async () => seen.setColour("draft" as ArtifactLabel, null));
    expect(shown()).toEqual(["none", "none"]);
  });

  it("reads own keys only, so a label named __proto__ is never the prototype", () => {
    const crossed = { draft: "teal", __proto__: null } as unknown as ArtifactLabelColours;
    const plain = JSON.parse('{"review":"red"}') as ArtifactLabelColours;
    expect([...labelColoursMap(crossed)]).toEqual([["draft", "teal"]]);
    expect(labelColoursMap(plain).get("__proto__" as ArtifactLabel)).toBeUndefined();
    expect([...labelColoursMap(JSON.parse('{"__proto__":"pink","x":"nope"}') as ArtifactLabelColours)]).toEqual([["__proto__", "pink"]]);
  });

  it("says a label's colour after its name", () => {
    expect(labelColourWords("draft", "teal")).toBe("draft, teal");
    expect(labelColourWords("draft", null)).toBe("draft, no colour");
  });
});
