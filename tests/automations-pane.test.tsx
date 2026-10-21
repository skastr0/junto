// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS } from "@shared/automation";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import { AutomationsPane } from "../src/renderer/components/automations/AutomationsPane";
import { makeLocalAutomationsSource, setAutomationsSource } from "../src/renderer/lib/automations-source";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const canvas = "automations-pane";
const node = asNodeId("automations-1");
let host: HTMLDivElement;
let root: Root;
let source: ReturnType<typeof makeLocalAutomationsSource>;

const render = async (): Promise<void> => {
  await act(async () => root.render(<AutomationsPane canvasName={canvas} nodeId={node} author={{ kind: "operator" }} />));
};

const button = (name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll("button")].find((element) => element.textContent?.trim() === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};

beforeEach(() => {
  source = makeLocalAutomationsSource();
  setAutomationsSource(source);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("automations pane", () => {
  it("starts empty with a way to make the first one", async () => {
    await render();
    expect(host.textContent).toContain("No automations yet");
    await act(async () => button("New automation").click());
    expect(host.querySelector('[data-testid="automation-editor"]')).not.toBeNull();
    expect(host.textContent).toContain("New automation, not saved");
    // The new mail has no recipient yet, so Save waits.
    expect(host.textContent).toContain("Pick who the mail goes to.");
    expect(button("Save").disabled).toBe(true);
  });

  it("lists the node's automations with their trigger, and opens one with its history", async () => {
    const automationId = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
    await source.apply(canvas, node, automationId, {
      kind: "create",
      automationId,
      definition: {
        name: "Morning standup",
        enabled: true,
        trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
        then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan." }],
        limits: DEFAULT_AUTOMATION_LIMITS,
      },
    });
    source.record(canvas, {
      firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF1"),
      automationId,
      at: 1_000,
      cause: { kind: "run" },
      outcome: { kind: "skipped", reason: "condition_unmet" },
    });
    await render();
    expect(host.textContent).toContain("Morning standup");
    expect(host.textContent).toContain("weekdays 09:00, UTC");
    await act(async () => button("Morning standupweekdays 09:00, UTC").click());
    expect(host.textContent).toContain("Run by hand, skipped: a condition did not hold");
    expect(button("Save").disabled).toBe(true);
  });
});
