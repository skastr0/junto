/**
 * The Automations node's editor (plan 0.10/07), pure: the draft the main pane
 * edits, the closed set of edits it takes, the check that turns a draft into
 * an `Automation` the contract decodes, and the words the sidebar and the
 * firing history show. No React, no I/O.
 *
 * A draft holds what the operator is typing: numbers as text, targets not yet
 * picked. `finishDraft` is the one door out, and it ends at `decodeAutomation`,
 * so nothing the contract refuses is ever sent. Field errors come first so the
 * pane can say which field is wrong, in words.
 */
import { Result, Schema } from "effect";
import { isValidCronExpression, describeCronExpression } from "@shared/cron-expression";
import {
  AUTOMATION_NAME_MAX_CHARS,
  AUTOMATION_STEPS_MAX,
  AUTOMATION_TEXT_MAX_CHARS,
  DEFAULT_AUTOMATION_LIMITS,
  MAX_PER_HOUR_CEILING,
  POLL_MIN_EVERY_MS,
  AutomationDefinition,
  type Action,
  type ActionRuling,
  type Automation,
  type AutomationAuthor,
  type AutomationId,
  type Condition,
  type Firing,
  type SeatBecomes,
  type SkipReason,
  type Trigger,
  type Watch,
  type WatchedSignal,
} from "@shared/automation";
import type { NodeId } from "@shared/physics/schema";
import { TASK_STATES } from "@shared/task-model";

// ── Shapes the contract names ──────────────────────────────────────────────

type SeatWatch = Extract<Watch, { readonly kind: "seat" }>;
type TaskWatch = Extract<Watch, { readonly kind: "task" }>;
type ArtifactWatch = Extract<Watch, { readonly kind: "artifact" }>;
type SignalWatch = Extract<Watch, { readonly kind: "signal" }>;

/** A seat, task, artifact or page, as a target is picked. */
export type TargetRef = SeatWatch["seat"];
/** A task, or any task on one board. */
export type TaskTarget = TaskWatch["task"];
export type TaskBecomes = TaskWatch["becomes"];
export type ArtifactEvent = ArtifactWatch["event"];
type CommentAction = Extract<Action, { readonly kind: "comment" }>;
/** What a comment may be on: a task, an artifact or a page, never a seat. */
export type CommentTarget = CommentAction["on"];

export type EditableTriggerKind = "schedule" | "poll" | "change";
export type WatchKind = Watch["kind"];
export type ConditionKind = Condition["kind"];
export type ActionKind = Action["kind"];

export const SEAT_BECOMES: ReadonlyArray<SeatBecomes> = ["idle", "working", "attention", "gone"];
export const TASK_BECOMES: ReadonlyArray<TaskBecomes> = TASK_STATES;
export const ARTIFACT_EVENTS: ReadonlyArray<ArtifactEvent> = ["edited", "commented"];
export const SIGNALS: ReadonlyArray<WatchedSignal> = ["escalate", "blocked", "feedback"];

// ── The draft ──────────────────────────────────────────────────────────────

export type WatchDraft =
  | { readonly kind: "seat"; readonly seat?: TargetRef; readonly becomes: SeatBecomes }
  | { readonly kind: "task"; readonly task?: TaskTarget; readonly becomes: TaskBecomes }
  | { readonly kind: "artifact"; readonly artifact?: TargetRef; readonly event: ArtifactEvent }
  | { readonly kind: "signal"; readonly from?: TargetRef; readonly signal: WatchedSignal };

export type ConditionDraft = Extract<WatchDraft, { readonly kind: ConditionKind }>;

export type TriggerDraft =
  | { readonly kind: "schedule"; readonly cron: string; readonly timezone: string }
  | { readonly kind: "poll"; readonly everyMinutes: string }
  | { readonly kind: "change"; readonly on: WatchDraft }
  /** Kept as loaded: 0.10 refuses it, the editor does not offer it. */
  | { readonly kind: "webhook"; readonly endpointId: string };

export type ActionDraft =
  | { readonly kind: "mail"; readonly to?: TargetRef; readonly text: string }
  | { readonly kind: "create-task"; readonly node?: NodeId; readonly title: string; readonly assign?: TargetRef }
  | { readonly kind: "assign-task"; readonly task?: TargetRef; readonly to?: TargetRef }
  | {
      readonly kind: "comment";
      readonly on?: CommentTarget;
      /** Kept as loaded; the editor does not pick anchors. */
      readonly anchor?: CommentAction["anchor"];
      readonly text: string;
    };

export type AutomationDraft = {
  readonly automationId: AutomationId;
  readonly nodeId: NodeId;
  readonly author: AutomationAuthor;
  readonly name: string;
  readonly enabled: boolean;
  readonly trigger: TriggerDraft;
  readonly when: ReadonlyArray<ConditionDraft>;
  readonly then: ReadonlyArray<ActionDraft>;
  /** One stable key per condition and per action, so a row keeps its own field state through moves and removals. */
  readonly whenKeys: ReadonlyArray<string>;
  readonly thenKeys: ReadonlyArray<string>;
  readonly minIntervalMinutes: string;
  readonly maxPerHour: string;
};

const MINUTE_MS = 60_000;

const minutesText = (ms: number): string => String(ms / MINUTE_MS);

let keysMinted = 0;
const mintKey = (): string => `row-${(keysMinted += 1)}`;
const keysFor = (count: number): ReadonlyArray<string> => Array.from({ length: count }, mintKey);

/** The timezone the runtime reports, the default for a new schedule. */
export const localTimezone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

export const blankWatch = (kind: WatchKind): WatchDraft => {
  switch (kind) {
    case "seat":
      return { kind, becomes: "idle" };
    case "task":
      return { kind, becomes: "done" };
    case "artifact":
      return { kind, event: "edited" };
    case "signal":
      return { kind, signal: "blocked" };
    default:
      return kind satisfies never;
  }
};

export const blankTrigger = (kind: EditableTriggerKind, timezone: string = localTimezone()): TriggerDraft => {
  switch (kind) {
    case "schedule":
      return { kind, cron: "0 9 * * 1-5", timezone };
    case "poll":
      return { kind, everyMinutes: minutesText(POLL_MIN_EVERY_MS * 5) };
    case "change":
      return { kind, on: blankWatch("seat") };
    default:
      return kind satisfies never;
  }
};

export const blankAction = (kind: ActionKind): ActionDraft => {
  switch (kind) {
    case "mail":
      return { kind, text: "" };
    case "create-task":
      return { kind, title: "" };
    case "assign-task":
      return { kind };
    case "comment":
      return { kind, text: "" };
    default:
      return kind satisfies never;
  }
};

/** A new automation: a weekday morning schedule that mails nobody yet. */
export const newDraft = (
  automationId: AutomationId,
  nodeId: NodeId,
  author: AutomationAuthor,
  timezone: string = localTimezone(),
): AutomationDraft => ({
  automationId,
  nodeId,
  author,
  name: "New automation",
  enabled: false,
  trigger: blankTrigger("schedule", timezone),
  when: [],
  then: [blankAction("mail")],
  whenKeys: [],
  thenKeys: keysFor(1),
  minIntervalMinutes: minutesText(DEFAULT_AUTOMATION_LIMITS.minIntervalMs),
  maxPerHour: String(DEFAULT_AUTOMATION_LIMITS.maxPerHour),
});

const watchDraftOf = (watch: Watch): WatchDraft => watch;

const triggerDraftOf = (trigger: Trigger): TriggerDraft => {
  switch (trigger.kind) {
    case "schedule":
      return { kind: "schedule", cron: trigger.cron, timezone: trigger.timezone };
    case "poll":
      return { kind: "poll", everyMinutes: minutesText(trigger.everyMs) };
    case "change":
      return { kind: "change", on: watchDraftOf(trigger.on) };
    case "webhook":
      return { kind: "webhook", endpointId: trigger.endpointId };
    default:
      return trigger satisfies never;
  }
};

const conditionDraftOf = (condition: Condition): ConditionDraft => {
  const { holds: _holds, ...watch } = condition;
  return watch;
};

/** A stored automation, as the editor holds it. */
export const draftOf = (automation: Automation): AutomationDraft => ({
  automationId: automation.automationId,
  nodeId: automation.nodeId,
  author: automation.author,
  name: automation.name,
  enabled: automation.enabled,
  trigger: triggerDraftOf(automation.trigger),
  when: (automation.when ?? []).map(conditionDraftOf),
  then: automation.then,
  whenKeys: keysFor(automation.when?.length ?? 0),
  thenKeys: keysFor(automation.then.length),
  minIntervalMinutes: minutesText(automation.limits.minIntervalMs),
  maxPerHour: String(automation.limits.maxPerHour),
});

// ── Edits ──────────────────────────────────────────────────────────────────

export type DraftEdit =
  | { readonly type: "name"; readonly name: string }
  | { readonly type: "enabled"; readonly enabled: boolean }
  | { readonly type: "trigger-kind"; readonly kind: EditableTriggerKind }
  | { readonly type: "trigger"; readonly trigger: TriggerDraft }
  | { readonly type: "add-condition"; readonly kind: ConditionKind }
  | { readonly type: "condition"; readonly index: number; readonly condition: ConditionDraft }
  | { readonly type: "remove-condition"; readonly index: number }
  | { readonly type: "add-action"; readonly kind: ActionKind }
  | { readonly type: "action"; readonly index: number; readonly action: ActionDraft }
  | { readonly type: "action-kind"; readonly index: number; readonly kind: ActionKind }
  | { readonly type: "move-action"; readonly index: number; readonly step: -1 | 1 }
  | { readonly type: "remove-action"; readonly index: number }
  | { readonly type: "min-interval"; readonly minutes: string }
  | { readonly type: "max-per-hour"; readonly count: string };

const replaceAt = <A>(list: ReadonlyArray<A>, index: number, item: A): ReadonlyArray<A> =>
  index < 0 || index >= list.length ? list : list.map((old, at) => (at === index ? item : old));

const removeAt = <A>(list: ReadonlyArray<A>, index: number): ReadonlyArray<A> =>
  list.filter((_, at) => at !== index);

const moveAt = <A>(list: ReadonlyArray<A>, index: number, step: -1 | 1): ReadonlyArray<A> => {
  const target = index + step;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
};

/** One edit applied. An edit out of range or over a cap leaves the draft as it is. */
export const editDraft = (draft: AutomationDraft, edit: DraftEdit): AutomationDraft => {
  switch (edit.type) {
    case "name":
      return { ...draft, name: edit.name };
    case "enabled":
      return { ...draft, enabled: edit.enabled };
    case "trigger-kind": {
      if (draft.trigger.kind === edit.kind) return draft;
      const timezone = draft.trigger.kind === "schedule" ? draft.trigger.timezone : undefined;
      return { ...draft, trigger: blankTrigger(edit.kind, timezone) };
    }
    case "trigger":
      return { ...draft, trigger: edit.trigger };
    case "add-condition":
      if (draft.when.length >= AUTOMATION_STEPS_MAX) return draft;
      return {
        ...draft,
        when: [...draft.when, blankWatch(edit.kind) as ConditionDraft],
        whenKeys: [...draft.whenKeys, mintKey()],
      };
    case "condition":
      return { ...draft, when: replaceAt(draft.when, edit.index, edit.condition) };
    case "remove-condition":
      return { ...draft, when: removeAt(draft.when, edit.index), whenKeys: removeAt(draft.whenKeys, edit.index) };
    case "add-action":
      if (draft.then.length >= AUTOMATION_STEPS_MAX) return draft;
      return { ...draft, then: [...draft.then, blankAction(edit.kind)], thenKeys: [...draft.thenKeys, mintKey()] };
    case "action":
      return { ...draft, then: replaceAt(draft.then, edit.index, edit.action) };
    case "action-kind": {
      const old = draft.then[edit.index];
      if (old === undefined || old.kind === edit.kind) return draft;
      return { ...draft, then: replaceAt(draft.then, edit.index, carriedAction(old, edit.kind)) };
    }
    case "move-action":
      return {
        ...draft,
        then: moveAt(draft.then, edit.index, edit.step),
        thenKeys: moveAt(draft.thenKeys, edit.index, edit.step),
      };
    case "remove-action":
      return { ...draft, then: removeAt(draft.then, edit.index), thenKeys: removeAt(draft.thenKeys, edit.index) };
    case "min-interval":
      return { ...draft, minIntervalMinutes: edit.minutes };
    case "max-per-hour":
      return { ...draft, maxPerHour: edit.count };
    default:
      return edit satisfies never;
  }
};

/** A changed action kind keeps the text typed so far, where the new kind has text. */
const carriedAction = (old: ActionDraft, kind: ActionKind): ActionDraft => {
  const text = old.kind === "mail" || old.kind === "comment" ? old.text : old.kind === "create-task" ? old.title : "";
  switch (kind) {
    case "mail":
      return { kind, text };
    case "comment":
      return { kind, text };
    case "create-task":
      return { kind, title: text };
    case "assign-task":
      return { kind };
    default:
      return kind satisfies never;
  }
};

// ── Finishing: draft to Automation ─────────────────────────────────────────

/** Where a problem is, so the pane can mark the field. */
export type DraftField =
  | { readonly at: "name" }
  | { readonly at: "trigger" }
  | { readonly at: "condition"; readonly index: number }
  | { readonly at: "actions" }
  | { readonly at: "action"; readonly index: number }
  | { readonly at: "limits" };

export type DraftProblem = DraftField & { readonly message: string };

const wholeNumber = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : undefined;
};

/** Minutes as typed, in whole milliseconds: `1.5` is 90000. A stored interval always reads back. */
const minutesMs = (text: string): number | undefined => {
  const trimmed = text.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const ms = Math.round(Number(trimmed) * MINUTE_MS);
  return Number.isSafeInteger(ms) ? ms : undefined;
};

const isKnownTimezone = (timezone: string): boolean => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
};

const textProblem = (text: string, max: number, what: string): string | undefined => {
  const trimmed = text.trim();
  if (trimmed.length === 0) return `Write the ${what}.`;
  if (trimmed.length > max) return `The ${what} is longer than ${max} characters.`;
  return undefined;
};

const watchProblem = (watch: WatchDraft): string | undefined => {
  switch (watch.kind) {
    case "seat":
      return watch.seat === undefined ? "Pick the seat to watch." : undefined;
    case "task":
      return watch.task === undefined ? "Pick the task to watch." : undefined;
    case "artifact":
      return watch.artifact === undefined ? "Pick the artifact to watch." : undefined;
    case "signal":
      return undefined;
    default:
      return watch satisfies never;
  }
};

const triggerProblem = (trigger: TriggerDraft): string | undefined => {
  switch (trigger.kind) {
    case "schedule":
      if (!isValidCronExpression(trigger.cron)) return "The schedule is not a five-field cron, such as 0 9 * * 1-5.";
      if (!isKnownTimezone(trigger.timezone.trim())) return `${trigger.timezone.trim() || "That"} is not a timezone this machine knows.`;
      return undefined;
    case "poll": {
      const ms = minutesMs(trigger.everyMinutes);
      if (ms === undefined) return "Polling takes a number of minutes, such as 5.";
      if (ms < POLL_MIN_EVERY_MS) return `Polling runs at most once every ${POLL_MIN_EVERY_MS / MINUTE_MS} minute.`;
      if (ms > 7 * 24 * 60 * MINUTE_MS) return "Polling runs at least once a week.";
      return undefined;
    }
    case "change":
      return watchProblem(trigger.on);
    case "webhook":
      return "Webhook triggers are not available yet. Pick another trigger.";
    default:
      return trigger satisfies never;
  }
};

const actionProblem = (action: ActionDraft): string | undefined => {
  switch (action.kind) {
    case "mail":
      if (action.to === undefined) return "Pick who the mail goes to.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "mail");
    case "create-task":
      if (action.node === undefined) return "Pick the task board.";
      return textProblem(action.title, AUTOMATION_NAME_MAX_CHARS, "task title");
    case "assign-task":
      if (action.task === undefined) return "Pick the task to assign.";
      if (action.to === undefined) return "Pick the seat to assign it to.";
      return undefined;
    case "comment":
      if (action.on === undefined) return "Pick what the comment is on.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "comment");
    default:
      return action satisfies never;
  }
};

/** Every problem in the draft, in the order the pane shows its fields. */
export const draftProblems = (draft: AutomationDraft): ReadonlyArray<DraftProblem> => {
  const problems: Array<DraftProblem> = [];
  const name = textProblem(draft.name, AUTOMATION_NAME_MAX_CHARS, "name");
  if (name) problems.push({ at: "name", message: name });
  const trigger = triggerProblem(draft.trigger);
  if (trigger) problems.push({ at: "trigger", message: trigger });
  draft.when.forEach((condition, index) => {
    const message = watchProblem(condition);
    if (message) problems.push({ at: "condition", index, message });
  });
  if (draft.then.length === 0) problems.push({ at: "actions", message: "Add at least one action." });
  draft.then.forEach((action, index) => {
    const message = actionProblem(action);
    if (message) problems.push({ at: "action", index, message });
  });
  const minInterval = minutesMs(draft.minIntervalMinutes);
  const maxPerHour = wholeNumber(draft.maxPerHour);
  if (minInterval === undefined || minInterval > 24 * 60 * MINUTE_MS) {
    problems.push({ at: "limits", message: "The quiet time between firings is 0 to 1440 minutes." });
  }
  if (maxPerHour === undefined || maxPerHour < 1 || maxPerHour > MAX_PER_HOUR_CEILING) {
    problems.push({ at: "limits", message: `An automation fires 1 to ${MAX_PER_HOUR_CEILING} times an hour.` });
  }
  return problems;
};

const triggerOf = (trigger: TriggerDraft): unknown => {
  switch (trigger.kind) {
    case "schedule":
      return { kind: "schedule", cron: trigger.cron.trim().replace(/\s+/g, " "), timezone: trigger.timezone.trim() };
    case "poll":
      return { kind: "poll", everyMs: minutesMs(trigger.everyMinutes) };
    case "change":
      return { kind: "change", on: trigger.on };
    case "webhook":
      return trigger;
    default:
      return trigger satisfies never;
  }
};

const actionOf = (action: ActionDraft): unknown => {
  switch (action.kind) {
    case "mail":
    case "comment":
      return { ...action, text: action.text.trim() };
    case "create-task":
      return { ...action, title: action.title.trim() };
    case "assign-task":
      return action;
    default:
      return action satisfies never;
  }
};

const decodeDefinition = Schema.decodeUnknownResult(AutomationDefinition, { onExcessProperty: "error" });

export type FinishedDraft =
  | { readonly ok: true; readonly definition: AutomationDefinition }
  | { readonly ok: false; readonly problems: ReadonlyArray<DraftProblem> };

/**
 * The draft as the definition a writer sends, or what stops it. Identity,
 * author and version stay with main; on and off travels on its own. Ends at the contract's own decode, so a
 * draft that passes every field check and still breaks the contract is
 * refused too, never sent.
 */
export const finishDraft = (draft: AutomationDraft): FinishedDraft => {
  const problems = draftProblems(draft);
  if (problems.length > 0) return { ok: false, problems };
  const decoded = decodeDefinition({
    name: draft.name.trim(),
    trigger: triggerOf(draft.trigger),
    ...(draft.when.length > 0 ? { when: draft.when.map((condition) => ({ ...condition, holds: true })) } : {}),
    then: draft.then.map(actionOf),
    limits: {
      minIntervalMs: minutesMs(draft.minIntervalMinutes),
      maxPerHour: Number(draft.maxPerHour.trim()),
    },
  });
  return Result.isSuccess(decoded)
    ? { ok: true, definition: decoded.success }
    : { ok: false, problems: [{ at: "name", message: "This automation does not fit the contract. Check every field." }] };
};

// ── Words ──────────────────────────────────────────────────────────────────

/** How a target is named in a sentence: `@product-feed`, `#42 fix tabs`. */
export type NameOf = (ref: TargetRef) => string;

const becomesWords: Readonly<Record<SeatBecomes, string>> = {
  idle: "goes idle",
  working: "starts working",
  attention: "needs you",
  gone: "is gone",
};

const taskWords = (task: TaskTarget | undefined, nameOf: NameOf): string =>
  task === undefined ? "a task" : "kind" in task ? nameOf(task) : "any task on its board";

const signalWords: Readonly<Record<WatchedSignal, string>> = {
  escalate: "escalates",
  blocked: "is blocked",
  feedback: "posts feedback",
};

export const watchWords = (watch: WatchDraft, nameOf: NameOf): string => {
  switch (watch.kind) {
    case "seat":
      return `${watch.seat ? nameOf(watch.seat) : "a seat"} ${becomesWords[watch.becomes]}`;
    case "task":
      return `${taskWords(watch.task, nameOf)} is ${watch.becomes.replace("-", " ")}`;
    case "artifact":
      return `${watch.artifact ? nameOf(watch.artifact) : "an artifact"} is ${watch.event}`;
    case "signal":
      return `${watch.from ? nameOf(watch.from) : "any seat"} ${signalWords[watch.signal]}`;
    default:
      return watch satisfies never;
  }
};

/** The trigger in a few words, for the sidebar row and the pane's header. */
export const triggerWords = (trigger: TriggerDraft, nameOf: NameOf): string => {
  switch (trigger.kind) {
    case "schedule":
      return `${describeCronExpression(trigger.cron)}, ${trigger.timezone}`;
    case "poll": {
      const ms = minutesMs(trigger.everyMinutes);
      return ms === undefined ? "polls" : ms === MINUTE_MS ? "every minute" : `every ${ms / MINUTE_MS} minutes`;
    }
    case "change":
      return `when ${watchWords(trigger.on, nameOf)}`;
    case "webhook":
      return "webhook, not available yet";
    default:
      return trigger satisfies never;
  }
};

export const actionWords = (action: ActionDraft, nameOf: NameOf): string => {
  switch (action.kind) {
    case "mail":
      return `mail ${action.to ? nameOf(action.to) : "someone"}`;
    case "create-task":
      return `create a task${action.assign ? ` for ${nameOf(action.assign)}` : ""}`;
    case "assign-task":
      return `assign ${action.task ? nameOf(action.task) : "a task"} to ${action.to ? nameOf(action.to) : "a seat"}`;
    case "comment":
      return `comment on ${action.on ? nameOf(action.on) : "a task, artifact or page"}`;
    default:
      return action satisfies never;
  }
};

export const ACTION_LABEL: Readonly<Record<ActionKind, string>> = {
  mail: "Send mail",
  "create-task": "Create a task",
  "assign-task": "Assign a task",
  comment: "Comment",
};

export const TRIGGER_LABEL: Readonly<Record<EditableTriggerKind, string>> = {
  schedule: "On a schedule",
  poll: "Every few minutes",
  change: "When something changes",
};

export const WATCH_LABEL: Readonly<Record<WatchKind, string>> = {
  seat: "A seat",
  task: "A task",
  artifact: "An artifact",
  signal: "A signal",
};

const skipWords: Readonly<Record<SkipReason, string>> = {
  disabled: "it was off",
  condition_unmet: "a condition did not hold",
  min_interval: "it fired too recently",
  max_per_hour: "it reached its hourly limit",
  out_of_reach: "a target was out of its reach",
  not_available: "its trigger is not available",
};

const missedWords = (missed: number): string =>
  missed === 0 ? "" : ` (${missed} earlier ${missed === 1 ? "slot" : "slots"} missed)`;

const causeWords = (cause: Firing["cause"]): string => {
  switch (cause.kind) {
    case "schedule":
      return `Scheduled${missedWords(cause.missed)}`;
    case "poll":
      return `Polled${missedWords(cause.missed)}`;
    case "change":
      return "Changed";
    case "run":
      return "Run by hand";
    default:
      return cause satisfies never;
  }
};

/** One line of the firing history: `Scheduled, fired, 2 of 2 actions applied`. */
export const firingWords = (firing: Firing): string => {
  const cause = causeWords(firing.cause);
  switch (firing.outcome.kind) {
    case "fired": {
      const actions = firing.outcome.actions;
      const count = (ruling: ActionRuling["ruling"]): number => actions.filter((action) => action.ruling === ruling).length;
      const queued = count("queued");
      const refused = count("refused");
      return [
        `${cause}, fired, ${count("applied")} of ${actions.length} ${actions.length === 1 ? "action" : "actions"} applied`,
        ...(queued > 0 ? [`${queued} queued`] : []),
        ...(refused > 0 ? [`${refused} refused`] : []),
      ].join(", ");
    }
    case "skipped":
      return `${cause}, skipped: ${skipWords[firing.outcome.reason]}`;
    default:
      return firing.outcome satisfies never;
  }
};

/** Newest first, a stable order for equal times. */
export const historyOrder = (firings: ReadonlyArray<Firing>): ReadonlyArray<Firing> =>
  [...firings].sort((a, b) => b.at - a.at || (a.firingId < b.firingId ? 1 : a.firingId > b.firingId ? -1 : 0));

