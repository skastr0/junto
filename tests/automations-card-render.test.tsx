// @vitest-environment jsdom
/**
 * The Automations node's card in the Spines language: what the operator reads
 * on the canvas, from the node's one list read and its last outcomes.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type AutomationDefinition } from "@shared/automation";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import { AutomationsCard } from "../src/renderer/components/automations/AutomationsCard";
import { makeLocalAutomationsSource, setAutomationsSource } from "../src/renderer/lib/automations-source";
import { nodeUrgency$ } from "../src/renderer/lib/region-urgency";
import { state$ } from "../src/renderer/lib/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const canvas = "automations-card";
const node = asNodeId("automations-1");
const first = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
const second = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA2");
const definition = (name: string): AutomationDefinition => ({
  name,
  trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan." }],
  limits: DEFAULT_AUTOMATION_LIMITS,
});

let host: HTMLDivElement;
let root: Root;
let source: ReturnType<typeof makeLocalAutomationsSource>;

const render = async (): Promise<void> => {
  await act(async () => root.render(<AutomationsCard nodeId={node} renaming={false} onRenameDone={() => undefined} />));
};
const text = (): string => document.body.textContent ?? "";

beforeEach(() => {
  state$.canvasName.set(canvas);
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

describe("Automations card", () => {
  it("an empty node says so, with no tag", async () => {
    await render();
    expect(text()).toContain("No automations yet");
    expect(document.body.querySelector(".spine-tag")).toBeNull();
  });

  it("shows the count, on and off, and each row's name and trigger in words", async () => {
    await source.apply(canvas, node, first, { kind: "create", automationId: first, enabled: true, definition: definition("Morning standup") });
    await source.apply(canvas, node, second, { kind: "create", automationId: second, enabled: false, definition: definition("Evening digest") });
    await render();
    expect(document.body.querySelector(".spine-chip__count")?.textContent).toBe("2");
    expect(text()).toContain("1 on, 1 off");
    expect(text()).toContain("Morning standup");
    expect(text()).toContain("weekdays 09:00, UTC");
    expect(document.body.querySelector('[data-on="false"]')).not.toBeNull();
    // Off is said in words to a screen reader, not by the hollow mark alone.
    expect(text()).toContain("Evening digest, off");
  });

  it("Failed when the last firing had an action refused; the row and the region say so, and it clears", async () => {
    await source.apply(canvas, node, first, { kind: "create", automationId: first, enabled: true, definition: definition("Morning standup") });
    source.record(canvas, {
      firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF1"),
      automationId: first,
      at: 1_000,
      cause: { kind: "run" },
      outcome: { kind: "fired", actions: [{ index: 0, ruling: "refused", reason: "not_in_reach" }] },
    });
    await render();
    expect(document.body.querySelector(".spine-tag")?.textContent).toBe("Failed");
    expect(document.body.querySelector('.spine__row[data-tone="crimson"]')).not.toBeNull();
    expect(nodeUrgency$[node].peek()).toBe("blocked");
    await act(async () => root.unmount());
    expect(nodeUrgency$[node].peek()).toBeUndefined();
    root = createRoot(host);
  });

  it("Off when every one is off", async () => {
    await source.apply(canvas, node, first, { kind: "create", automationId: first, enabled: false, definition: definition("Morning standup") });
    await render();
    expect(document.body.querySelector(".spine-tag")?.textContent).toBe("Off");
    expect(nodeUrgency$[node].peek()).toBeUndefined();
  });
});
