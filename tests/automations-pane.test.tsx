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
  await act(async () => root.render(<AutomationsPane canvasName={canvas} nodeId={node} author={{ kind: "operator" }} onClose={() => undefined} />));
};

const button = (name: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll("button")].find((element) => element.textContent?.trim() === name);
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
  const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Automation name"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const nameShown = (): string => document.body.querySelector<HTMLInputElement>('input[aria-label="Automation name"]')!.value;

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("automations pane", () => {
  it("starts empty with a way to make the first one", async () => {
    await render();
    expect(document.body.textContent).toContain("No automations yet");
    await act(async () => button("New automation").click());
    expect(document.body.querySelector('[data-testid="automation-editor"]')).not.toBeNull();
    expect(document.body.textContent).toContain("New automation, not saved");
    // Problems wait for a save to be tried: the new mail has no recipient yet.
    expect(document.body.textContent).not.toContain("Pick who the mail goes to.");
    expect(document.body.querySelector('[role="alert"]')).toBeNull();
    await act(async () => button("Save").click());
    expect(document.body.textContent).toContain("Pick who the mail goes to.");
    expect(document.body.querySelector('[role="status"]')?.textContent).toBe("One thing to fix before it saves.");
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
    expect(document.body.textContent).toContain("Morning standup");
    expect(document.body.textContent).toContain("weekdays 09:00, UTC");
    await act(async () => button("Morning standupweekdays 09:00, UTC").click());
    expect(document.body.textContent).toContain("Run by hand, skipped: a condition did not hold");
    // aria-disabled, not disabled, so a Save that lands keeps keyboard focus.
    expect(button("Save").getAttribute("aria-disabled")).toBe("true");
  });

  it("saves an edit over the version it was loaded from", async () => {
    await opened();
    await typeName("Evening standup");
    await act(async () => button("Save").click());
    expect((await stored()).name).toBe("Evening standup");
    expect((await stored()).version).toBe(2);
  });

  it("New, from the empty state or the sidebar, puts focus on the new automation's name", async () => {
    await render();
    button("New automation").focus();
    await act(async () => button("New automation").click());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Automation name");

    await act(async () => root.unmount());
    root = createRoot(host);
    await opened();
    const sidebarNew = document.body.querySelector<HTMLButtonElement>('button[aria-label="New automation"]')!;
    sidebarNew.focus();
    await act(async () => sidebarNew.click());
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Automation name");

    // With unsaved edits New asks first; the dialog gives focus back as it closes, and the name still wins.
    await typeName("Unsaved");
    sidebarNew.focus();
    await act(async () => sidebarNew.click());
    expect(document.body.textContent).toContain("Discard your edits?");
    await act(async () => button("Discard").click());
    expect(nameShown()).toBe("New automation");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Automation name");
  });

  it("keeps keyboard focus where the press was: Save and Run now stay focused, Archive hands it to New", async () => {
    await opened();
    await typeName("Evening standup");
    button("Save").focus();
    await act(async () => button("Save").click());
    expect((await stored()).name).toBe("Evening standup");
    expect(document.activeElement).toBe(button("Save"));
    // Inert, not disabled: a second press does nothing.
    await act(async () => button("Save").click());
    expect((await stored()).version).toBe(2);

    button("Run now").focus();
    await act(async () => button("Run now").click());
    expect(document.activeElement).toBe(button("Run now"));

    button("Archive").focus();
    await act(async () => button("Archive").click());
    await act(async () => [...document.body.querySelectorAll("button")].filter((element) => element.textContent?.trim() === "Archive").at(-1)!.click());
    expect(document.body.textContent).toContain("No automations yet");
    expect(document.activeElement?.getAttribute("aria-label")).toBe("New automation");
  });

  it("a stale save keeps the draft and can send it over the head, or take the head", async () => {
    await opened();
    await typeName("Mine");
    await act(async () => {
      await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: (await stored()).version, definition: { ...definition, name: "Theirs" } });
    });
    await act(async () => button("Save").click());
    expect(document.body.textContent).toContain("Someone saved this automation since you opened it.");
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
      apply: async (...args) =>
        args[3].kind === "archive"
          ? { kind: "refused", refusal: { reason: "not_available", message: "this machine has no installation id yet" } }
          : apply(...args),
    });
    await act(async () => button("Archive").click());
    expect(document.body.textContent).toContain("Archive Morning standup?");
    await act(async () => [...document.body.querySelectorAll("button")].filter((element) => element.textContent?.trim() === "Archive").at(-1)!.click());
    expect(document.body.querySelector('[data-testid="automation-editor"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Not available: this machine has no installation id yet");
    setAutomationsSource(source);
    await act(async () => button("Archive").click());
    await act(async () => [...document.body.querySelectorAll("button")].filter((element) => element.textContent?.trim() === "Archive").at(-1)!.click());
    expect(document.body.querySelector('[data-testid="automation-editor"]')).toBeNull();
    expect((await source.list(canvas, node)).automations).toEqual([]);
  });

  it("off the editing machine a save is refused not_available, and the pane says where to make it", async () => {
    await opened();
    // Main's refusal from a copy (automation/apply.ts): never queued.
    setAutomationsSource({
      ...source,
      apply: async () => ({
        kind: "refused",
        refusal: {
          reason: "not_available",
          message: `automations on "${canvas}" are written on Studio Mac, the machine that edits it`,
          next_step: `Open "${canvas}" on Studio Mac to change its automations`,
        },
      }),
    });
    await typeName("Elsewhere");
    await act(async () => button("Save").click());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe(
      `Automations on "${canvas}" are written on Studio Mac, the machine that edits it. Open "${canvas}" on Studio Mac to change its automations.`,
    );
    // The draft stays, unsaved, and nothing is marked pending.
    expect(nameShown()).toBe("Elsewhere");
    expect((await stored()).name).toBe("Morning standup");
    expect(document.body.querySelector('[data-pending="true"]')).toBeNull();
  });

  it("a field's problem is its description", async () => {
    await opened();
    await typeName("  ");
    await act(async () => button("Save").click());
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Automation name"]')!;
    const described = input.getAttribute("aria-describedby");
    expect(described).not.toBeNull();
    expect(document.getElementById(described!)?.textContent).toBe("Write the name.");
  });

  it("a write that fails to reach main reads as a refusal, and the pane stays usable", async () => {
    await opened();
    setAutomationsSource({ ...source, apply: async () => Promise.reject(new Error("main is gone")) });
    await typeName("Lost");
    await act(async () => button("Save").click());
    expect(document.body.textContent).toContain("Not available: main is gone");
    expect(button("Save").disabled).toBe(false);
    setAutomationsSource(source);
  });
});
