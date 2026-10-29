// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type Automation, type AutomationDefinition } from "@shared/automation";
import { AUTOMATION_SIGNALS_ENABLED } from "@shared/features";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import { AutomationsPane } from "../src/renderer/components/automations/AutomationsPane";
import { makeLocalAutomationsSource, setAutomationsSource } from "../src/renderer/lib/automations-source";
import { setNodeViewStore } from "../src/renderer/lib/node-view-state";
import { makeMemoryNodeViewStore } from "../src/renderer/lib/view-state-stand-in";
import { loadLazySurfaces } from "../src/renderer/lib/lazy-surface";

// The editors and viewers load before any test, so no test waits on an import.
await loadLazySurfaces();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const canvas = "automations-pane-answered";
const node = asNodeId("automations-1");
let host: HTMLDivElement;
let root: Root;
let source: ReturnType<typeof makeLocalAutomationsSource>;

const render = async (): Promise<void> => {
  await act(async () => root.render(<AutomationsPane canvasName={canvas} nodeId={node} author={{ kind: "operator" }} onClose={() => undefined} />));
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

beforeEach(() => {
  setNodeViewStore(makeMemoryNodeViewStore());
  source = makeLocalAutomationsSource();
  setAutomationsSource(source);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

const automationId = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
const definition: AutomationDefinition = {
  name: "Morning standup",
  trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
  then: [{ kind: "signal", signal: "escalate", title: "Review the plan" }],
  limits: DEFAULT_AUTOMATION_LIMITS,
};

const stored = async (): Promise<Automation> =>
  (await source.list(canvas, node)).automations.find((automation) => automation.automationId === automationId)!;

/** One automation saved, then opened in the pane. */
const opened = async (): Promise<void> => {
  await source.apply(canvas, node, automationId, { kind: "create", automationId, enabled: true, definition });
  await render();
  await act(async () => button("Morning standupweekdays 09:00, UTC").click());
};

const nameShown = (): string => document.body.querySelector<HTMLInputElement>('input[aria-label="Automation name"]')!.value;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe.runIf(AUTOMATION_SIGNALS_ENABLED)("automations pane, answered back (0.11/09 H3)", () => {
  it("When answered saves the step's new id, then opens a new automation on this node whose trigger names it", async () => {
    await opened();
    await act(async () => button("When answered…").click());
    // The raising automation now names its step, so the watch survives a reorder.
    const raising = await stored();
    expect(raising.version).toBe(2);
    expect(raising.then[0]).toMatchObject({ kind: "signal", id: "review-the-plan" });
    // The new one is open, not saved yet, and its name is where the keyboard is.
    expect(nameShown()).toBe('When "Review the plan" is answered');
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Automation name");
    expect(document.body.textContent).toContain('When "Review the plan" is answered, not saved');
    expect(document.body.querySelector('[aria-label="Automation that raises it"]')?.textContent).toContain("Morning standup");
    expect(document.body.querySelector('[aria-label="Which of its signals"]')?.textContent).toContain('the step "Review the plan"');
    expect((await source.list(canvas, node)).automations).toHaveLength(1);
  });

  it("a step that has its id and nothing unsaved is not saved again", async () => {
    const named: AutomationDefinition = { ...definition, then: [{ kind: "signal", id: "plan", signal: "escalate", title: "Review the plan" }] };
    await source.apply(canvas, node, automationId, { kind: "create", automationId, enabled: true, definition: named });
    await render();
    await act(async () => button("Morning standupweekdays 09:00, UTC").click());
    await act(async () => button("When answered…").click());
    expect((await stored()).version).toBe(1);
    expect(nameShown()).toBe('When "Review the plan" is answered');
  });
});
