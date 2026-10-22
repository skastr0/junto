import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type Automation, type AutomationId } from "@shared/automation";
import { asNodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import { automationsCardFacts } from "../src/renderer/lib/automations-card";

const node = asNodeId("automations-1");
const idOf = (n: number): AutomationId => ItemId.make(`01JAAAAAAAAAAAAAAAAAAAAAA${n}`) as AutomationId;

const automation = (n: number, enabled = true): Automation =>
  ({
    automationId: idOf(n),
    nodeId: node,
    author: { kind: "operator" },
    version: 1 as Automation["version"],
    enabled,
    name: `Auto ${n}`,
    trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
    then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan." }],
    limits: DEFAULT_AUTOMATION_LIMITS,
  }) as Automation;

const never = {};
const nameOf = () => "a seat";

describe("Automations card facts", () => {
  it("an empty node says so, with no tag", () => {
    expect(automationsCardFacts([], never, nameOf)).toEqual({
      count: 0,
      meta: "No automations yet",
      rows: [],
      more: 0,
      status: undefined,
      ledger: { on: 0, off: 0, failed: 0 },
    });
  });

  it("counts every automation, says on and off, and gives each row its trigger in words", () => {
    const facts = automationsCardFacts([automation(1), automation(2, false)], never, nameOf);
    expect(facts.count).toBe(2);
    expect(facts.meta).toBe("1 on, 1 off");
    expect(facts.ledger).toEqual({ on: 1, off: 1, failed: 0 });
    expect(facts.rows.map((row) => [row.name, row.on, row.trigger])).toEqual([
      ["Auto 1", true, "weekdays 09:00, UTC"],
      ["Auto 2", false, "weekdays 09:00, UTC"],
    ]);
    expect(facts.status).toBeUndefined();
  });

  it("shows four rows, then +N more", () => {
    const facts = automationsCardFacts([1, 2, 3, 4, 5, 6].map((n) => automation(n)), never, nameOf);
    expect(facts.rows).toHaveLength(4);
    expect(facts.more).toBe(2);
  });

  it("Off when every one is off", () => {
    expect(automationsCardFacts([automation(1, false), automation(2, false)], never, nameOf).status).toBe("off");
  });

  it("Failed wins over Off, and a failed one is never hidden behind +N more", () => {
    const all = [1, 2, 3, 4, 5, 6].map((n) => automation(n, false));
    const facts = automationsCardFacts(all, { [idOf(6)]: "failed" }, nameOf);
    expect(facts.status).toBe("failed");
    expect(facts.ledger).toEqual({ on: 0, off: 6, failed: 1 });
    expect(facts.rows[0]).toMatchObject({ name: "Auto 6", failed: true });
    expect(facts.rows.filter((row) => row.failed)).toHaveLength(1);
  });

  it("only a failed last firing tags Failed: fired, skipped and claimed do not", () => {
    const outcomes = { [idOf(1)]: "fired", [idOf(2)]: "skipped", [idOf(3)]: "claimed" } as const;
    const facts = automationsCardFacts([automation(1), automation(2), automation(3)], outcomes, nameOf);
    expect(facts.status).toBeUndefined();
    expect(facts.rows.some((row) => row.failed)).toBe(false);
  });
});
