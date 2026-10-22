// @vitest-environment jsdom
/**
 * The Automations node's kind seat: what the operator reads on the canvas,
 * from the node's one list read and its last outcomes. The rows are in the
 * detail view, so the card says the counts and the ring says the state.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type AutomationDefinition } from "@shared/automation";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import { AutomationsCard } from "../src/renderer/components/automations/AutomationsCard";
import { kindStateOf } from "../src/renderer/components/nodes/KindSeat";
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
const seatState = (): string | undefined => document.body.querySelector<HTMLElement>('[data-testid="kind-seat"]')?.dataset["state"];

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
    expect(seatState()).toBe(kindStateOf(undefined));
  });

  it("is a kind seat that says on and off, with no rows on the canvas", async () => {
    await source.apply(canvas, node, first, { kind: "create", automationId: first, enabled: true, definition: definition("Morning standup") });
    await source.apply(canvas, node, second, { kind: "create", automationId: second, enabled: false, definition: definition("Evening digest") });
    await render();
    expect(document.body.querySelector('[data-testid="kind-seat"]')?.getAttribute("data-kind")).toBe("automations");
    expect(document.body.querySelector('[data-testid="kind-seat-line"]')?.textContent).toBe("1 on, 1 off");
    expect(text()).not.toContain("Morning standup");
    expect(seatState()).toBe(kindStateOf(undefined));
  });

  it("Failed when the last firing had an action refused: the ring says blocked, the region leans to it, and it clears", async () => {
    await source.apply(canvas, node, first, { kind: "create", automationId: first, enabled: true, definition: definition("Morning standup") });
    source.record(canvas, {
      firingId: ItemId.make("01JFFFFFFFFFFFFFFFFFFFFFF1"),
      automationId: first,
      at: 1_000,
      cause: { kind: "run" },
      outcome: { kind: "fired", actions: [{ index: 0, ruling: "refused", reason: "not_in_reach" }] },
    });
    await render();
    expect(seatState()).toBe(kindStateOf("failed"));
    expect(nodeUrgency$[node].peek()).toBe("blocked");
    await act(async () => root.unmount());
    expect(nodeUrgency$[node].peek()).toBeUndefined();
    root = createRoot(host);
  });

  it("renaming keeps the card, with the field in place of the name", async () => {
    await source.apply(canvas, node, first, { kind: "create", automationId: first, enabled: true, definition: definition("Morning standup") });
    await act(async () => root.render(<AutomationsCard nodeId={node} renaming onRenameDone={() => undefined} />));
    expect(document.body.querySelector('input[aria-label="Rename automations"]')).not.toBeNull();
    expect(text()).toContain("1 on, 0 off");
  });

  it("Off when every one is off", async () => {
    await source.apply(canvas, node, first, { kind: "create", automationId: first, enabled: false, definition: definition("Morning standup") });
    await render();
    expect(seatState()).toBe(kindStateOf("off"));
    expect(nodeUrgency$[node].peek()).toBeUndefined();
  });
});
