// @vitest-environment jsdom
/**
 * The 0.10 visual language components: what they say to assistive tech, and
 * which element they are. The drawing itself is checked in the specimen
 * screenshots; this locks the contract a composer relies on.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ListRow, PaneEmpty, PaneHeader, ResourceChip, StampTally, TaskStateMark, TwoPane } from "../src/renderer/components/ui";
import { nodeViewStore, setNodeViewStore } from "../src/renderer/lib/node-view-state";
import { makeMemoryNodeViewStore } from "../src/renderer/lib/view-state-stand-in";
import { TASK_STATES, stampTally } from "../src/renderer/lib/resource-visuals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (node: React.ReactNode) => act(() => root.render(node));

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ResourceChip", () => {
  it("is one button when it can open, and says what it is", () => {
    const onOpen = vi.fn();
    render(<ResourceChip kind="task" number={42} label="fix tabs" onOpen={onOpen} />);
    const button = host.querySelector("button");
    expect(button).not.toBeNull();
    expect(button?.textContent).toContain("#42");
    expect(button?.textContent).toContain("fix tabs");
    // The number is read where it is drawn, so it is not said a second time.
    expect(button?.textContent).not.toContain("Task 42");
    act(() => button?.click());
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("is a plain span, not a focus stop, when it only names", () => {
    render(<ResourceChip kind="seat" seat="agent-01" label="product-feed" />);
    expect(host.querySelector("button")).toBeNull();
    expect(host.querySelector("span.resource-chip")?.textContent).toContain("@product-feed");
  });

  it("marks a queued chip and says so", () => {
    render(<ResourceChip kind="page" label="Pricing" pending />);
    const chip = host.querySelector(".resource-chip");
    expect(chip?.getAttribute("data-pending")).toBe("true");
    expect(chip?.textContent).toContain("queued");
  });

  it("never opens a chip that is missing", () => {
    render(<ResourceChip kind="artifact" artifactType="sheet" label="Ledger" missing onOpen={() => undefined} />);
    expect(host.querySelector("button")).toBeNull();
    expect(host.textContent).toContain("Sheet");
    expect(host.textContent).toContain("unavailable");
  });
});

describe("TaskStateMark", () => {
  it("names every state to assistive tech when it has no label", () => {
    for (const state of TASK_STATES) {
      render(<TaskStateMark state={state} />);
      expect(host.querySelector("[role='img']")?.getAttribute("aria-label")).toBeTruthy();
    }
  });

  it("says queued, and stops pulsing the working lamp", () => {
    render(<TaskStateMark state="working" withLabel pending />);
    expect(host.textContent).toBe("Working, queued");
    expect(host.querySelector(".junto-status-dot-pulse")).toBeNull();
  });
});

describe("StampTally", () => {
  it("speaks the summary once and hides the caps", () => {
    render(<StampTally tally={stampTally(2, [{ verdict: "approve", epoch: 1 }], 1)} />);
    expect(host.querySelector("[role='img']")?.getAttribute("aria-label")).toBe("1 of 2 approved");
    expect(host.querySelectorAll(".stamp-tally__cap")).toHaveLength(2);
  });
});

describe("ListRow pending", () => {
  it("marks a queued row and reads it as queued", () => {
    render(<ListRow title="Draft plan" pending onClick={() => undefined} />);
    expect(host.querySelector("button")?.getAttribute("data-pending")).toBe("true");
    expect(host.textContent).toContain("queued");
  });
});

describe("TwoPane", () => {
  it("names each pane and draws the rail only when given one", () => {
    render(
      <TwoPane sidebarLabel="Artifacts" mainLabel="Notes" sidebar={<span>list</span>}>
        <PaneEmpty title="Nothing selected" />
      </TwoPane>,
    );
    expect(host.querySelector("[aria-label='Artifacts']")).not.toBeNull();
    expect(host.querySelector("[aria-label='Notes']")).not.toBeNull();
    expect(host.querySelector(".two-pane__rail")).toBeNull();
    render(
      <TwoPane sidebarLabel="Artifacts" mainLabel="Notes" railLabel="Comments" sidebar={<span>list</span>} rail={<span>r</span>}>
        <span>main</span>
      </TwoPane>,
    );
    expect(host.querySelector("[aria-label='Comments']")).not.toBeNull();
  });
  it("a pane that names its node keeps the sidebar collapse in view state, per node", () => {
    setNodeViewStore(makeMemoryNodeViewStore());
    const pane = (node: string) => (
      <TwoPane keptBy={{ canvas: "main", node }} sidebarLabel="Tasks" mainLabel="Task" sidebar={<PaneHeader eyebrow="Tasks" />}>
        <span>main</span>
      </TwoPane>
    );
    const toggle = () => host.querySelector<HTMLButtonElement>("[data-sidebar-toggle]")!;
    render(pane("tasks-1"));
    act(() => toggle().click());
    expect(nodeViewStore().sidebarCollapsed("main", "tasks-1")).toBe(true);
    expect(host.querySelector(".two-pane")!.getAttribute("data-sidebar")).toBe("collapsed");
    // Another node with the same sidebar label keeps its own.
    render(pane("tasks-2"));
    expect(host.querySelector(".two-pane")!.getAttribute("data-sidebar")).toBeNull();
    act(() => root.unmount());
    root = createRoot(host);
    render(pane("tasks-1"));
    expect(host.querySelector(".two-pane")!.getAttribute("data-sidebar")).toBe("collapsed");
    act(() => host.querySelector<HTMLButtonElement>(".two-pane__strip [data-sidebar-toggle]")!.click());
    expect(nodeViewStore().sidebarCollapsed("main", "tasks-1")).toBe(false);
  });
});
