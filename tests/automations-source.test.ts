import { describe, expect, it } from "vitest";
import { DEFAULT_AUTOMATION_LIMITS, type AutomationDefinition, type Firing } from "../src/shared/automation";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";
import { makeLocalAutomationsSource } from "../src/renderer/lib/automations-source";

const canvas = "factory";
const node = asNodeId("automations-1");
const automationId = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
const definition: AutomationDefinition = {
  name: "Morning",
  trigger: { kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" },
  then: [{ kind: "mail", to: { kind: "seat", nodeId: asNodeId("agent-a") }, text: "Plan." }],
  limits: DEFAULT_AUTOMATION_LIMITS,
};

const created = async () => {
  const source = makeLocalAutomationsSource();
  const result = await source.apply(canvas, node, automationId, { kind: "create", automationId, enabled: true, definition });
  if (result.kind !== "applied" || !result.automation) throw new Error("create refused");
  return { source, head: result.automation };
};

describe("local automations source", () => {
  it("creates at version 1 with the author main sets, listed on its node only", async () => {
    const { source, head } = await created();
    expect(head.version).toBe(1);
    expect(head.author).toEqual({ kind: "operator" });
    expect((await source.list(canvas, node)).automations).toEqual([head]);
    expect((await source.list(canvas, asNodeId("other"))).automations).toEqual([]);
    expect((await source.list("elsewhere", node)).automations).toEqual([]);
  });

  it("refuses an edit from a base that moved stale, with the head version expected", async () => {
    const { source, head } = await created();
    const first = await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: head.version, definition: { ...definition, name: "A" } });
    expect(first.kind === "applied" && first.automation?.version).toBe(2);
    const second = await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: head.version, definition: { ...definition, name: "B" } });
    expect(second).toEqual({ kind: "refused", refusal: { reason: "stale", message: "edited since", expected: 2 } });
  });

  it("an edit replaces the whole definition: a dropped condition is gone", async () => {
    const source = makeLocalAutomationsSource();
    const when = [{ kind: "seat", seat: { kind: "seat", nodeId: asNodeId("agent-b") }, becomes: "idle", holds: true }] as const;
    const made = await source.apply(canvas, node, automationId, { kind: "create", automationId, enabled: true, definition: { ...definition, when } });
    if (made.kind !== "applied" || !made.automation) throw new Error("create refused");
    expect(made.automation.when).toEqual(when);
    const edited = await source.apply(canvas, node, automationId, { kind: "edit", baseVersion: made.automation.version, definition });
    expect(edited.kind === "applied" && edited.automation && "when" in edited.automation).toBe(false);
  });

  it("turns on and off without a base, so a toggle never goes stale", async () => {
    const { source } = await created();
    const on = await source.apply(canvas, node, automationId, { kind: "set-enabled", enabled: true });
    expect(on.kind === "applied" && on.automation?.enabled).toBe(true);
  });

  it("refuses a definition the contract refuses", async () => {
    const source = makeLocalAutomationsSource();
    const result = await source.apply(canvas, node, automationId, { kind: "create", automationId, enabled: false, definition: { ...definition, then: [] } });
    expect(result.kind).toBe("refused");
  });

  it("pages firings newest first, archives, and refuses ops on what is gone", async () => {
    const { source } = await created();
    const firing = (n: number): Firing => ({
      firingId: ItemId.make(`01JFFFFFFFFFFFFFFFFFFFFFF${n}`),
      automationId,
      at: n * 1000,
      cause: { kind: "run" },
      outcome: { kind: "skipped", reason: "disabled" },
    });
    for (const n of [1, 2, 3]) source.record(canvas, firing(n));
    const page = await source.firings(canvas, { automationId, limit: 2 });
    expect(page.firings.map((entry) => entry.at)).toEqual([3000, 2000]);
    const older = await source.firings(canvas, { automationId, before: page.firings[1]!.firingId });
    expect(older.firings.map((entry) => entry.at)).toEqual([1000]);
    expect((await source.apply(canvas, node, automationId, { kind: "archive" })).kind).toBe("applied");
    expect((await source.list(canvas, node)).automations).toEqual([]);
    expect((await source.apply(canvas, node, automationId, { kind: "run" })).kind).toBe("refused");
  });
});
