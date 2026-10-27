// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mintItemId } from "../src/shared/resource-command";
import type { TaskView } from "../src/shared/task-model";
import { ArtifactTasks } from "../src/renderer/components/artifacts/ArtifactTasks";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
const render = (node: React.ReactNode) => act(() => root.render(node));

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

const task = (title: string, number: number): TaskView =>
  ({ taskId: mintItemId(), number, title, current: { node: "tasks" }, layers: [], dependsOn: [], createdAt: 0, updatedAt: 0 }) as unknown as TaskView;

describe("artifact tasks", () => {
  it("names linked tasks as chips that open them, and unlinks one", () => {
    const ship = task("Ship tabs", 12);
    const onOpen = vi.fn();
    const onChange = vi.fn();
    render(<ArtifactTasks taskIds={[ship.taskId]} tasks={[ship]} readOnly={false} onChange={onChange} onOpen={onOpen} />);
    const chip = [...host.querySelectorAll("button")].find((button) => button.textContent?.includes("Ship tabs"));
    act(() => chip?.click());
    expect(onOpen).toHaveBeenCalledWith(ship);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Unlink Ship tabs"]')?.click());
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("keeps a chip for a task the canvas no longer lists, without opening it", () => {
    const gone = mintItemId();
    render(<ArtifactTasks taskIds={[gone]} tasks={[]} readOnly onChange={() => {}} onOpen={() => {}} />);
    expect(host.textContent).toContain(`Task ${gone.slice(-6)}`);
    expect(host.querySelector('[aria-label^="Unlink"]')).toBeNull();
  });

  it("offers only unlinked tasks and names the picked one", () => {
    const linked = task("Linked", 1);
    const other = task("Other", 2);
    const onChange = vi.fn();
    render(<ArtifactTasks taskIds={[linked.taskId]} tasks={[linked, other]} readOnly={false} onChange={onChange} onOpen={() => {}} />);
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="Name a task"]')?.click());
    const options = [...host.querySelectorAll('[role="option"]')];
    expect(options.map((option) => option.textContent)).toEqual([expect.stringContaining("Other")]);
    act(() => (options[0] as HTMLElement).click());
    expect(onChange).toHaveBeenCalledWith([linked.taskId, other.taskId]);
  });

  it("closes the picker on Escape and gives focus back to the link button", () => {
    render(<ArtifactTasks taskIds={[]} tasks={[task("Other", 2)]} readOnly={false} onChange={() => {}} onOpen={() => {}} />);
    const button = host.querySelector<HTMLButtonElement>('[aria-label="Name a task"]');
    act(() => button?.click());
    expect(host.querySelector('[aria-label="Find a task"]')).not.toBeNull();
    act(() => {
      host.querySelector('[aria-label="Find a task"]')?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(host.querySelector('[aria-label="Find a task"]')).toBeNull();
    expect(document.activeElement).toBe(button);
  });
});
