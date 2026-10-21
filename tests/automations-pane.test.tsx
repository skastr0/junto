// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type Automation, type AutomationDefinition } from "@shared/automation";
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

const automationId = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
const definition: AutomationDefinition = {
  name: "Morning standup",
  trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan." }],
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

const typeName = async (name: string): Promise<void> => {
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Automation name"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const nameShown = (): string => host.querySelector<HTMLInputElement>('input[aria-label="Automation name"]')!.value;

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
    // Problems wait for a save to be tried: the new mail has no recipient yet.
    expect(host.textContent).not.toContain("Pick who the mail goes to.");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Save").click());
    expect(host.textContent).toContain("Pick who the mail goes to.");
    expect(host.querySelector('[role="status"]')?.textContent).toBe("One thing to fix before it saves.");
    expect((await source.list(canvas, node)).automations).toEqual([]);
  });

  it("lists the node's automations with their trigger, and opens one with its history", async () => {
    await source.apply(canvas, node, automationId, { kind: "create", automationId, enabled: true, definition });
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

  it("saves an edit over the version it was loaded from", async () => {
    await opened();
    await typeName("Evening standup");
    await act(async () => button("Save").click());
    expect((await stored()).name).toBe("Evening standup");
    expect((await stored()).version).toBe(2);
  });

  it("a stale save keeps the draft and can send it over the head, or take the head", async () => {
    await opened();
    await typeName("Mine");
    await act(async () => {
      await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: (await stored()).version, definition: { ...definition, name: "Theirs" } });
    });
    await act(async () => button("Save").click());
    expect(host.textContent).toContain("Someone saved this automation since you opened it.");
    expect(nameShown()).toBe("Mine");
    await act(async () => button("Send mine over theirs").click());
    expect((await stored()).name).toBe("Mine");
    expect((await stored()).version).toBe(3);

    await typeName("Mine again");
    await act(async () => {
      await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: 3 as Automation["version"], definition: { ...definition, name: "Theirs again" } });
    });
    await act(async () => button("Save").click());
    await act(async () => button("Take theirs").click());
    expect(nameShown()).toBe("Theirs again");
  });

  it("a save never undoes a toggle made elsewhere", async () => {
    await opened();
    await typeName("Renamed");
    await act(async () => {
      await source.apply(canvas, node, automationId, { kind: "set-enabled", enabled: false });
    });
    await act(async () => button("Save").click());
    expect((await stored()).name).toBe("Renamed");
    expect((await stored()).enabled).toBe(false);
  });

  it("a draft with no unsent change follows its head", async () => {
    await opened();
    await act(async () => {
      await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: (await stored()).version, definition: { ...definition, name: "Edited elsewhere" } });
    });
    expect(nameShown()).toBe("Edited elsewhere");
  });

  it("archive asks first and closes only once applied", async () => {
    await opened();
    const apply = source.apply;
    setAutomationsSource({
      ...source,
      apply: async (...args) => (args[3].kind === "archive" ? { kind: "refused", refusal: { reason: "queue_full", message: "full" } } : apply(...args)),
    });
    await act(async () => button("Archive").click());
    expect(document.body.textContent).toContain("Archive Morning standup?");
    await act(async () => [...document.body.querySelectorAll("button")].filter((element) => element.textContent?.trim() === "Archive").at(-1)!.click());
    expect(host.querySelector('[data-testid="automation-editor"]')).not.toBeNull();
    expect(host.textContent).toContain("the queue for the editing machine is full");
    setAutomationsSource(source);
    await act(async () => button("Archive").click());
    await act(async () => [...document.body.querySelectorAll("button")].filter((element) => element.textContent?.trim() === "Archive").at(-1)!.click());
    expect(host.querySelector('[data-testid="automation-editor"]')).toBeNull();
    expect((await source.list(canvas, node)).automations).toEqual([]);
  });

  it("a queued save marks its row until the editing machine rules, then clears", async () => {
    await opened();
    const apply = source.apply;
    setAutomationsSource({ ...source, apply: async (...args) => (args[3].kind === "edit" ? { kind: "queued" } : apply(...args)) });
    await typeName("Queued name");
    await act(async () => button("Save").click());
    expect(host.textContent).toContain("Queued: the editing machine has not ruled on it yet.");
    expect(host.textContent).toContain(", queued");
    setAutomationsSource(source);
    // The ruling lands: the head moves.
    await act(async () => {
      await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: (await stored()).version, definition: { ...definition, name: "Queued name" } });
    });
    expect(host.textContent).not.toContain("Queued: the editing machine");
    expect(host.textContent).not.toContain(", queued");
  });

  it("a field's problem is its description", async () => {
    await opened();
    await typeName("  ");
    await act(async () => button("Save").click());
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Automation name"]')!;
    const described = input.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    expect(document.getElementById(described!)?.textContent).toBe("Write the name.");
  });
});
