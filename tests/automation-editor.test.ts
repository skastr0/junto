import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  AUTOMATION_STEPS_MAX,
  AutomationVersion,
  DEFAULT_AUTOMATION_LIMITS,
  decodeAutomation,
  type Automation,
  type AutomationDefinition,
  type Firing,
} from "../src/shared/automation";
import { asNodeId } from "../src/shared/physics/schema";
import { ItemId } from "../src/shared/work-ids";
import {
  actionWords,
  draftOf,
  draftProblems,
  editDraft,
  finishDraft,
  firingWords,
  historyOrder,
  newDraft,
  triggerWords,
  type AutomationDraft,
  type DraftEdit,
  type NameOf,
  type TargetRef,
} from "../src/renderer/lib/automation-editor";

const id = ItemId.make("01JAAAAAAAAAAAAAAAAAAAAAA1");
const t1 = ItemId.make("01JTTTTTTTTTTTTTTTTTTTTTT1");
const node = asNodeId("automations-1");
const seat = (nodeId: string): TargetRef => ({ kind: "seat", nodeId: asNodeId(nodeId) });
const nameOf: NameOf = (ref) => (ref.kind === "seat" ? `@${ref.nodeId}` : `#${ref.nodeId}`);

const blank = (): AutomationDraft => newDraft(id, node, { kind: "operator" }, "UTC");
const apply = (draft: AutomationDraft, ...edits: ReadonlyArray<DraftEdit>): AutomationDraft =>
  edits.reduce(editDraft, draft);

/** A blank draft with its one mail action filled in. */
const ready = (): AutomationDraft =>
  apply(blank(), { type: "action", index: 0, action: { kind: "mail", to: seat("agent-a"), text: "  Post your plan.  " } });

const finished = (draft: AutomationDraft): AutomationDefinition => {
  const result = finishDraft(draft);
  if (!result.ok) throw new Error(result.problems.map((problem) => problem.message).join("; "));
  return result.definition;
};

/** The definition as main stores it. */
const storedAs = (definition: AutomationDefinition): Automation => ({
  automationId: id,
  nodeId: node,
  author: { kind: "operator" },
  version: AutomationVersion.make(3),
  enabled: false,
  ...definition,
});

describe("automation editor draft", () => {
  it("a new draft starts off, on a weekday schedule, with one mail to fill in", () => {
    const draft = blank();
    expect(draft.enabled).toBe(false);
    expect(draft.trigger).toEqual({ kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" });
    expect(draft.then).toEqual([{ kind: "mail", text: "" }]);
    expect(draftProblems(draft)).toEqual([{ at: "action", index: 0, message: "Pick who the mail goes to." }]);
  });

  it("finishes into an automation the contract decodes, text trimmed", () => {
    const automation = finished(ready());
    expect(Result.isSuccess(decodeAutomation(storedAs(automation)))).toBe(true);
    expect(automation.then).toEqual([{ kind: "mail", to: seat("agent-a"), text: "Post your plan." }]);
    expect(automation.limits).toEqual(DEFAULT_AUTOMATION_LIMITS);
    expect(automation.when).toBeUndefined();
  });

  it("round-trips a stored automation through the draft unchanged", () => {
    const stored = finished(
      apply(
        ready(),
        { type: "trigger-kind", kind: "change" },
        { type: "trigger", trigger: { kind: "change", on: { kind: "signal", signal: "blocked" } } },
        { type: "add-condition", kind: "seat" },
        { type: "condition", index: 0, condition: { kind: "seat", seat: seat("agent-b"), becomes: "idle" } },
        { type: "min-interval", minutes: "5" },
        { type: "max-per-hour", count: "3" },
      ),
    );
    expect(stored.when).toEqual([{ kind: "seat", seat: seat("agent-b"), becomes: "idle", holds: true }]);
    expect(stored.limits).toEqual({ minIntervalMs: 300_000, maxPerHour: 3 });
    expect(finished(draftOf(storedAs(stored)))).toEqual(stored);
  });

  it("names each field that is wrong, in the order the pane shows them", () => {
    const draft = apply(
      blank(),
      { type: "name", name: "   " },
      { type: "trigger", trigger: { kind: "schedule", cron: "every morning", timezone: "UTC" } },
      { type: "remove-action", index: 0 },
      { type: "max-per-hour", count: "0" },
    );
    expect(draftProblems(draft).map((problem) => problem.at)).toEqual(["name", "trigger", "actions", "limits"]);
    expect(finishDraft(draft).ok).toBe(false);
  });

  it("refuses a poll under the floor, a timezone the runtime does not know, and a webhook", () => {
    const poll = apply(ready(), { type: "trigger-kind", kind: "poll" }, {
      type: "trigger",
      trigger: { kind: "poll", everyMinutes: "0" },
    });
    expect(draftProblems(poll)[0]?.message).toMatch(/at most once every 1 minute/);
    const zone = apply(ready(), { type: "trigger", trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Mars/Olympus" } });
    expect(draftProblems(zone)[0]?.message).toMatch(/Mars\/Olympus is not a timezone/);
    const hook = apply(ready(), { type: "trigger", trigger: { kind: "webhook", endpointId: "e1" } });
    expect(draftProblems(hook)[0]?.message).toMatch(/not available/);
  });

  it("a poll every 5 minutes finishes as 300000 ms", () => {
    const draft = apply(ready(), { type: "trigger-kind", kind: "poll" });
    expect(finished(draft).trigger).toEqual({ kind: "poll", everyMs: 300_000 });
  });

  it("switching trigger kinds keeps the timezone only when coming back to a schedule from one", () => {
    const zoned = apply(blank(), { type: "trigger", trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "Asia/Tokyo" } });
    expect(apply(zoned, { type: "trigger-kind", kind: "schedule" })).toBe(zoned);
    expect(apply(zoned, { type: "trigger-kind", kind: "change" }).trigger).toEqual({
      kind: "change",
      on: { kind: "seat", becomes: "idle" },
    });
  });

  it("changing an action's kind carries its text over", () => {
    const draft = apply(ready(), { type: "action-kind", index: 0, kind: "create-task" });
    expect(draft.then[0]).toEqual({ kind: "create-task", title: "  Post your plan.  " });
    expect(apply(draft, { type: "action-kind", index: 0, kind: "assign-task" }).then[0]).toEqual({ kind: "assign-task" });
  });

  it("loads and saves an interval that is not whole minutes", () => {
    const stored = storedAs({ ...finished(ready()), limits: { minIntervalMs: 90_000, maxPerHour: 4 } });
    const draft = draftOf(stored);
    expect(draft.minIntervalMinutes).toBe("1.5");
    expect(finished(draft).limits).toEqual({ minIntervalMs: 90_000, maxPerHour: 4 });
  });

  it("each action keeps its key through moves and removals", () => {
    const three = apply(ready(), { type: "add-action", kind: "comment" }, { type: "add-action", kind: "assign-task" });
    const [first, second, third] = three.thenKeys;
    expect(new Set(three.thenKeys).size).toBe(3);
    expect(apply(three, { type: "move-action", index: 2, step: -1 }).thenKeys).toEqual([first, third, second]);
    expect(apply(three, { type: "remove-action", index: 0 }).thenKeys).toEqual([second, third]);
    const conditions = apply(three, { type: "add-condition", kind: "seat" }, { type: "add-condition", kind: "task" });
    expect(apply(conditions, { type: "remove-condition", index: 0 }).whenKeys).toEqual([conditions.whenKeys[1]]);
  });

  it("moves, removes and caps actions; out-of-range edits change nothing", () => {
    const two = apply(ready(), { type: "add-action", kind: "comment" });
    expect(two.then.map((action) => action.kind)).toEqual(["mail", "comment"]);
    expect(apply(two, { type: "move-action", index: 1, step: -1 }).then.map((action) => action.kind)).toEqual(["comment", "mail"]);
    expect(apply(two, { type: "move-action", index: 1, step: 1 })).toEqual(two);
    expect(apply(two, { type: "action", index: 9, action: { kind: "mail", text: "x" } })).toEqual(two);
    let full = blank();
    for (let at = 0; at < AUTOMATION_STEPS_MAX + 3; at += 1) full = editDraft(full, { type: "add-action", kind: "mail" });
    expect(full.then).toHaveLength(AUTOMATION_STEPS_MAX);
  });
});

describe("automation words", () => {
  it("says the trigger and each action in a few words", () => {
    expect(triggerWords({ kind: "schedule", cron: "0 9 * * 1-5", timezone: "UTC" }, nameOf)).toBe("weekdays 09:00, UTC");
    expect(triggerWords({ kind: "poll", everyMinutes: "1" }, nameOf)).toBe("every minute");
    expect(triggerWords({ kind: "change", on: { kind: "seat", seat: seat("agent-a"), becomes: "attention" } }, nameOf)).toBe(
      "when @agent-a needs you",
    );
    expect(triggerWords({ kind: "change", on: { kind: "task", task: { node: asNodeId("tasks-1") }, becomes: "in-review" } }, nameOf)).toBe(
      "when any task on its board is in review",
    );
    expect(actionWords({ kind: "mail", to: seat("agent-a"), text: "x" }, nameOf)).toBe("mail @agent-a");
    expect(actionWords({ kind: "comment", on: { kind: "task", nodeId: asNodeId("tasks-1"), taskId: t1 }, text: "x" }, nameOf)).toBe(
      "comment on #tasks-1",
    );
  });

  it("says each firing, newest first", () => {
    const firing = (firingId: string, at: number, outcome: Firing["outcome"]): Firing =>
      ({ firingId, automationId: id, at, cause: { kind: "schedule", slot: at, missed: 0 }, outcome }) as Firing;
    const fired = firing("f1", 10, {
      kind: "fired",
      actions: [{ index: 0, ruling: "applied" }, { index: 1, ruling: "queued" }, { index: 2, ruling: "refused", reason: "stale" }],
    });
    const skipped = firing("f2", 20, { kind: "skipped", reason: "max_per_hour" });
    expect(firingWords(fired)).toBe("Scheduled, fired, 1 of 3 actions applied, 1 queued, 1 refused");
    expect(firingWords({ ...skipped, cause: { kind: "poll", slot: 20, missed: 2 } })).toBe(
      "Polled (2 earlier slots missed), skipped: it reached its hourly limit",
    );
    expect(firingWords(skipped)).toBe("Scheduled, skipped: it reached its hourly limit");
    expect(firingWords(firing("f3", 30, { kind: "claimed" }))).toBe("Scheduled, interrupted before its actions were ruled");
    expect(historyOrder([fired, skipped]).map((entry) => entry.firingId)).toEqual(["f2", "f1"]);
  });
});
