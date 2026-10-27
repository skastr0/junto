// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactLink } from "../src/shared/artifact-link";
import type { MentionOf } from "../src/shared/mention";
import { asNodeId } from "../src/shared/physics/schema";
import type { ItemId } from "../src/shared/work-ids";
import { MentionCombobox, type ComboboxLinks } from "../src/renderer/components/ui/MentionCombobox";
import type { LinkableArtifact } from "../src/renderer/lib/artifact-link-draft";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const shelf = asNodeId("artifacts-shelf");
const ref = (artifactId: string): MentionOf<"artifact"> => ({ kind: "artifact", nodeId: shelf, artifactId: artifactId as ItemId });
const plan: LinkableArtifact = { ref: ref("01M5ZBT64KHP4JGH67RV1YCS6B"), title: "Launch plan", type: "document" };
const board: LinkableArtifact = { ref: ref("01M5ZBT64KHP4JGH67RV1YCS6C"), title: "Plan board", type: "pad", place: "Archive" };
const made = ref("01M5ZBT64KHP4JGH67RV1YCS6D");

let host: HTMLDivElement;
let root: Root;
let written: string;
let created: string[];
let landCreate: ((value: MentionOf<"artifact"> | null) => void) | undefined;

function Harness({ links }: { readonly links: ComboboxLinks }) {
  const [value, setValue] = useState("");
  return (
    <MentionCombobox
      value={value}
      onValueChange={(next) => {
        written = next;
        setValue(next);
      }}
      canvasName="factory"
      candidates={[]}
      listLabel={() => ""}
      nodeKindOf={(nodeId) => (nodeId === shelf ? "artifacts" : undefined)}
      links={links}
      aria-label="Shape text"
    />
  );
}

const field = (): HTMLTextAreaElement => host.querySelector("textarea")!;
const options = (): HTMLLIElement[] => [...host.querySelectorAll<HTMLLIElement>('[role="option"]')];
const live = (): string => host.querySelector('[aria-live="polite"]')!.textContent ?? "";

const type = (text: string): void => {
  const element = field();
  const next = `${element.value}${text}`;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(element, next);
    element.setSelectionRange(next.length, next.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const press = (key: string): void => {
  act(() => {
    field().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
};

const links: ComboboxLinks = {
  artifacts: [plan, board],
  create: (title) => {
    created.push(title);
    return new Promise((resolve) => {
      landCreate = resolve;
    });
  },
};

beforeEach(() => {
  written = "";
  created = [];
  landCreate = undefined;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Harness links={links} />));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("MentionCombobox [[ links", () => {
  it("[[ opens the artifacts to link, titles starting with the query first, then a create row", () => {
    type("see [[plan");
    expect(host.querySelector('[role="listbox"]')!.getAttribute("aria-label")).toBe("Artifacts to link");
    expect(options().map((option) => option.textContent)).toEqual(["Plan boardArchivePad", "Launch planDocument", "Create document planNew"]);
  });

  it("a pick writes the [[Title]] link in place of the query, and says so", () => {
    type("see [[laun");
    press("Enter");
    expect(written).toBe(`see ${artifactLink(plan.ref, "Launch plan", "factory")} `);
    expect(field().value).toBe("see [[Launch plan]] ");
    expect(live()).toBe("Linked Launch plan");
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("the create row makes the document, one at a time, and links it where [[ was", async () => {
    type("a [[Roadmap");
    expect(options().at(-1)!.textContent).toBe("Create document RoadmapNew");
    press("ArrowUp");
    press("Enter");
    expect(created).toEqual(["Roadmap"]);
    expect(live()).toBe("Creating Roadmap");
    // While it is made there is no create row to press again.
    expect(options().some((option) => option.dataset.kind === "create")).toBe(false);
    await act(async () => landCreate!(made));
    expect(written).toBe(`a ${artifactLink(made, "Roadmap", "factory")} `);
    expect(live()).toBe("Created and linked Roadmap");
  });

  it("a create that makes nothing leaves the text and says so", async () => {
    type("[[Nope");
    press("ArrowUp");
    press("Enter");
    await act(async () => landCreate!(null));
    expect(field().value).toBe("[[Nope");
    expect(live()).toBe("Nope could not be created");
  });

  it("Escape shuts the list for that [[ only", () => {
    type("[[pl");
    press("Escape");
    expect(field().getAttribute("aria-expanded")).toBe("false");
    type("a");
    expect(field().getAttribute("aria-expanded")).toBe("false");
  });

  it("without links, [[ is only brackets", () => {
    act(() => root.render(<Harness links={undefined as never} />));
    type("[[plan");
    expect(host.querySelector('[role="listbox"]')).toBeNull();
  });
});
