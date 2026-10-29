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
  AUTOMATION_CODE_TIMEOUT_DEFAULT_MS,
  AUTOMATION_CODE_TIMEOUT_MAX_MS,
  AUTOMATION_CODE_TIMEOUT_MIN_MS,
  AUTOMATION_NAME_MAX_CHARS,
  AUTOMATION_STEPS_MAX,
  AUTOMATION_TEXT_MAX_CHARS,
  AUTOMATION_SIGNAL_MIN_WORDS_MAX,
  AUTOMATION_SIGNAL_SHOWS_MAX,
  DEFAULT_AUTOMATION_LIMITS,
  SignalKind,
  MAX_PER_HOUR_CEILING,
  POLL_MIN_EVERY_MS,
  AutomationDefinition,
  automationValuesOf,
  isCodeValueName,
  signalTakesForm,
  valueNamesIn,
  type Action,
  type ActionRuling,
  type ArtifactTarget as SharedArtifactTarget,
  type Automation,
  type AutomationAuthor,
  type AutomationId,
  type AutomationValue,
  type CodeLanguage,
  type Condition,
  type Firing,
  type SeatBecomes,
  type SkipReason,
  type Trigger,
  type Watch,
  type WatchedSignal,
} from "@shared/automation";
import { AGENT_SIGNAL_MAX_DETAIL_LENGTH, AGENT_SIGNAL_MAX_TEXT_LENGTH } from "@shared/wire/agent-signals";
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import { ARTIFACT_LABEL_RULE, ARTIFACT_LABELS_MAX, artifactLabelOf, artifactLabelsMatch, artifactLabelsOf, type ArtifactLabel } from "@shared/artifact-labels";
import type { NodeId } from "@shared/physics/schema";
import type { ContentRef } from "@shared/wire/content-ref";
import type { AgentSignal } from "@shared/wire/agent-signals";
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
/** An artifact, or any artifact in one Artifacts node, as a task watch's `{node}` is any task on a board. */
export type ArtifactScope = ArtifactWatch["artifact"];
/** What an artifact watch waits for: edited, commented on, or a label gained. */
export type ArtifactEvent = ArtifactWatch["event"];
/** The artifact an artifact action writes: one picked, or the one that fired. */
export type ArtifactTarget = SharedArtifactTarget;
type CommentAction = Extract<Action, { readonly kind: "comment" }>;
type SignalAction = Extract<Action, { readonly kind: "signal" }>;
type StoredSignalForm = NonNullable<SignalAction["form"]>;
/** A signal's form as the editor holds it: labels and the word minimum as typed. A secret is kept as loaded. */
export type SignalFormDraft =
  | { readonly kind: "text" }
  | {
      readonly kind: "artifact";
      readonly node?: NodeId;
      /** The document's title; the signal's title when empty. */
      readonly title?: string;
      readonly labels?: ReadonlyArray<string>;
      readonly minWords?: string;
    }
  | Extract<StoredSignalForm, { readonly kind: "secret" }>
  | { readonly kind: "proof" };
/** What a comment may be on: a task, an artifact or a page, never a seat. */
export type CommentTarget = CommentAction["on"];

export type EditableTriggerKind = "schedule" | "poll" | "change";
export type WatchKind = Watch["kind"];
export type ConditionKind = Condition["kind"];
export type ActionKind = Action["kind"];
export type SeatControlOp = Extract<Action, { readonly kind: "seat-control" }>["op"];
/** What a raised signal says to the operator: a seat's kinds, or a notice only to read (0.11/09). */
export type SignalRaise = SignalKind;
export const SIGNAL_RAISES: ReadonlyArray<SignalRaise> = SignalKind.literals;
export const SIGNAL_SHOWS_MAX = AUTOMATION_SIGNAL_SHOWS_MAX;

export const SEAT_BECOMES: ReadonlyArray<SeatBecomes> = ["idle", "working", "attention", "gone"];
export const TASK_BECOMES: ReadonlyArray<TaskBecomes> = TASK_STATES;
export const ARTIFACT_EVENTS: ReadonlyArray<ArtifactEvent> = ["edited", "commented", "labelled"];
export const SIGNALS: ReadonlyArray<WatchedSignal> = ["escalate", "blocked", "feedback"];

// ── The draft ──────────────────────────────────────────────────────────────

export type WatchDraft =
  | { readonly kind: "seat"; readonly seat?: TargetRef; readonly becomes: SeatBecomes }
  | { readonly kind: "task"; readonly task?: TaskTarget; readonly becomes: TaskBecomes }
  | {
      readonly kind: "artifact";
      readonly artifact?: ArtifactScope;
      readonly event: ArtifactEvent;
      /**
       * As typed, folded when it is finished. With `edited` or `commented`,
       * only an artifact carrying it; with `labelled`, the label it gains,
       * any label when there is none.
       */
      readonly label?: string;
    }
  | { readonly kind: "signal"; readonly from?: TargetRef; readonly signal: WatchedSignal }
  /** An automation's signal answered (0.11/09): made by a signal step's "When answered…", never picked blank. */
  | Extract<Watch, { readonly kind: "answered" }>;

/** The node a task or artifact watch covers, or undefined for one item, picked or not. */
export const watchedNode = (target: TaskTarget | ArtifactScope | undefined): NodeId | undefined =>
  target === undefined || "kind" in target ? undefined : target.node;

export type ConditionDraft = Extract<WatchDraft, { readonly kind: ConditionKind }>;

export type TriggerDraft =
  | { readonly kind: "schedule"; readonly cron: string; readonly timezone: string }
  | { readonly kind: "poll"; readonly everyMinutes: string }
  | { readonly kind: "change"; readonly on: WatchDraft }
  /** Kept as loaded: 0.10 refuses it, the editor does not offer it. */
  | { readonly kind: "webhook"; readonly endpointId: string };

export type ActionDraft =
  | { readonly kind: "mail"; readonly to?: TargetRef; readonly text: string }
  /** Mail sent as a prompt: the seat is asked to act, not only told. Seat only. */
  | { readonly kind: "prompt"; readonly to?: TargetRef; readonly text: string }
  /**
   * A program on the automation's machine. The code itself is staged content:
   * the draft holds the ref it is saved at, and the pane's code editor writes
   * the text (`codePut`) before the definition names it.
   */
  | {
      readonly kind: "code";
      readonly language: CodeLanguage;
      /** The timeout as typed, in seconds: the contract stores milliseconds. */
      readonly timeoutSeconds: string;
      readonly source?: ContentRef;
    }
  | { readonly kind: "create-task"; readonly node?: NodeId; readonly title: string; readonly assign?: TargetRef }
  | { readonly kind: "assign-task"; readonly task?: TargetRef; readonly to?: TargetRef }
  | {
      readonly kind: "comment";
      readonly on?: CommentTarget;
      /** Kept as loaded; the editor does not pick anchors. */
      readonly anchor?: CommentAction["anchor"];
      readonly text: string;
    }
  /** A document in an Artifacts node. No body stores an empty document; labels as typed, folded when finished. */
  | {
      readonly kind: "create-artifact";
      readonly node?: NodeId;
      readonly title: string;
      readonly body?: string;
      readonly labels?: ReadonlyArray<string>;
    }
  /** Text written at a document's end, exactly as written: the editor starts it with a dated heading. */
  | { readonly kind: "append-artifact"; readonly to?: ArtifactTarget; readonly text: string }
  /** A signal in the needs-you feed, raised by the automation; it may show artifacts. */
  | {
      readonly kind: "signal";
      readonly signal: SignalRaise;
      readonly title: string;
      readonly detail?: string;
      readonly show?: ReadonlyArray<TargetRef>;
      /** What the operator answers in; none is a reply. */
      readonly form?: SignalFormDraft;
      /** The step's id, for an answered watch; kept as loaded. */
      readonly id?: SignalAction["id"];
      /** Where its answer goes; kept as loaded. */
      readonly answerTo?: SignalAction["answerTo"];
    }
  /** A seat started or stopped where it runs. Seat only; it writes no text. */
  | { readonly kind: "seat-control"; readonly seat?: TargetRef; readonly op: SeatControlOp }
  /** Labels added to and removed from one artifact, as typed. */
  | {
      readonly kind: "label-artifact";
      readonly to?: ArtifactTarget;
      readonly add?: ReadonlyArray<string>;
      readonly remove?: ReadonlyArray<string>;
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

/** A code step's timeout as stored, in milliseconds: the default for a field that does not say one. */
export const codeTimeoutMs = (seconds: string): number => {
  const value = wholeNumber(seconds);
  return value === undefined ? AUTOMATION_CODE_TIMEOUT_DEFAULT_MS : value * 1000;
};

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

export const blankWatch = (kind: Exclude<WatchKind, "answered">): WatchDraft => {
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
    case "prompt":
      return { kind, text: "" };
    case "code":
      return { kind, language: "typescript", timeoutSeconds: String(AUTOMATION_CODE_TIMEOUT_DEFAULT_MS / 1000) };
    case "create-task":
      return { kind, title: "" };
    case "assign-task":
      return { kind };
    case "comment":
      return { kind, text: "" };
    case "create-artifact":
      return { kind, title: "" };
    case "append-artifact":
      return { kind, text: APPEND_HEADING };
    case "label-artifact":
      return { kind };
    case "seat-control":
      return { kind, op: "start" };
    case "signal":
      return { kind, signal: "notice", title: "" };
    default:
      return kind satisfies never;
  }
};

/**
 * A watch's label that no artifact where it looks carries yet, said under
 * the field: a typo there is a watch that never fires and looks fine. The
 * labels it does find come after, to pick the meant one from. Nothing while
 * the label matches, is empty, or breaks the rule (the save says that).
 */
export const labelNote = (
  typed: string | undefined,
  event: ArtifactEvent,
  /** Where the watch looks: "Specs", or "the Artifacts nodes in reach". */
  where: string,
  used: ReadonlyArray<ArtifactLabel>,
): string | undefined => {
  const label = typed === undefined ? undefined : artifactLabelOf(typed);
  if (label === undefined || artifactLabelsMatch(used, [label])) return undefined;
  const after = event === "labelled" ? " It fires when one gains it." : "";
  const known = used.length === 0 ? "" : ` Labels there: ${used.slice(0, 8).join(", ")}${used.length > 8 ? ", and more" : ""}.`;
  return `No artifact in ${where} carries ${label} yet.${after}${known}`;
};

/** A label note's first sentence, what a reader is told: the labels there stay in the description. */
export const labelNoteSpoken = (note: string | undefined): string => (note === undefined ? "" : note.split(" Labels there:")[0]!);

/** A new append starts as a dated section: the heading names when it fired. */
export const APPEND_HEADING = "## {{fired.at}}\n\n";

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

/** A stored action as the draft holds it: a code step's code is staged content, named by its ref. */
/**
 * Ms as hours to type: nine decimals hold any whole ms (an hour's ms over
 * 1e9 is under one), so it finishes back unchanged; trailing zeros go.
 */

const signalFormDraftOf = (form: StoredSignalForm): SignalFormDraft => {
  if (form.kind !== "artifact") return form;
  return {
    kind: "artifact",
    node: form.node,
    ...(form.title === undefined ? {} : { title: form.title }),
    ...(form.labels === undefined ? {} : { labels: form.labels }),
    ...(form.minWords === undefined ? {} : { minWords: String(form.minWords) }),
  };
};

const actionDraftOf = (action: Action): ActionDraft => {
  switch (action.kind) {
    case "signal": {
      const { form, ...rest } = action;
      return { ...rest, ...(form === undefined ? {} : { form: signalFormDraftOf(form) }) };
    }
    case "code":
      return {
        kind: "code",
        language: action.language,
        timeoutSeconds: String((action.timeoutMs ?? AUTOMATION_CODE_TIMEOUT_DEFAULT_MS) / 1000),
        source: action.source,
      };
    default:
      return action;
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
  then: automation.then.map(actionDraftOf),
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

/**
 * A changed action kind keeps what the new kind has: the text typed so far,
 * and the seat a mail or a prompt was addressed to.
 */
const carriedAction = (old: ActionDraft, kind: ActionKind): ActionDraft => {
  const text =
    old.kind === "mail" || old.kind === "prompt" || old.kind === "comment" || old.kind === "append-artifact"
      ? old.text
      : old.kind === "create-task" || old.kind === "create-artifact"
        ? old.title
        : "";
  const seat = old.kind === "mail" || old.kind === "prompt" ? old.to : old.kind === "seat-control" ? old.seat : undefined;
  switch (kind) {
    case "mail":
      return seat === undefined ? { kind, text } : { kind, text, to: seat };
    case "prompt":
      return seat === undefined ? { kind, text } : { kind, text, to: seat };
    case "comment":
      return { kind, text };
    case "create-task":
      return { kind, title: text };
    case "assign-task":
      return { kind };
    case "code":
      return blankAction("code");
    case "create-artifact":
      return { kind, title: old.kind === "create-task" ? old.title : "", ...(text === "" || old.kind === "create-task" ? {} : { body: text }) };
    case "append-artifact":
      return { kind, text: text === "" ? APPEND_HEADING : text };
    case "label-artifact":
      return { kind };
    case "seat-control":
      return seat === undefined ? { kind, op: "start" } : { kind, op: "start", seat };
    case "signal": {
      // A title carries over as the title; a text as the detail.
      const title = old.kind === "create-task" || old.kind === "create-artifact" ? old.title : "";
      const detail = title === "" ? text : "";
      return { kind, signal: "notice", title, ...(detail === "" ? {} : { detail }) };
    }
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
      if (watch.artifact === undefined) return "Pick the artifact to watch.";
      return watch.label === undefined || watch.label.trim() === "" ? undefined : labelsProblem([watch.label]);
    case "signal":
    case "answered":
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

/**
 * A value the trigger does not carry, at the action that writes it: main
 * refuses the same name at save (`valueRefusal`), and the editor says it
 * before the round trip, in the same words.
 */
const valueProblem = (text: string, carried: ReadonlyArray<string>, afterCode: boolean): string | undefined => {
  const missing = valueNamesIn(text).find((name) => !carried.includes(name) && !(afterCode && isCodeValueName(name)));
  if (missing === undefined) return undefined;
  return `This trigger carries no {{${missing}}}. It carries ${carried.map((name) => `{{${name}}}`).join(", ")}.`;
};

/** Labels as typed: undefined when every one folds to a label, else why not. */
const labelsProblem = (labels: ReadonlyArray<string>): string | undefined =>
  artifactLabelsOf(labels) === undefined
    ? labels.length > ARTIFACT_LABELS_MAX
      ? `An artifact holds at most ${ARTIFACT_LABELS_MAX} labels.`
      : ARTIFACT_LABEL_RULE
    : undefined;

/** Labels as typed, folded, unique and sorted, or none. */
const foldedLabels = (labels: ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  artifactLabelsOf((labels ?? []).filter((label) => label.trim() !== "")) ?? [];

const signalFormProblem = (form: SignalFormDraft | undefined): string | undefined => {
  if (form?.kind !== "artifact") return undefined;
  if (form.node === undefined) return "Pick the Artifacts node the writing goes to.";
  const title = form.title?.trim() ?? "";
  // The artifact's own bound, not the signal's: the title becomes the document's.
  if (title.length > ARTIFACT_MAX_TITLE_LENGTH) return `The document title is longer than ${ARTIFACT_MAX_TITLE_LENGTH} characters.`;
  const labels = labelsProblem((form.labels ?? []).filter((label) => label.trim() !== ""));
  if (labels) return labels;
  const typed = form.minWords?.trim() ?? "";
  const words = wholeNumber(typed);
  if (typed !== "" && (words === undefined || words < 1 || words > AUTOMATION_SIGNAL_MIN_WORDS_MAX))
    return `Ask for 1 to ${AUTOMATION_SIGNAL_MIN_WORDS_MAX.toLocaleString("en-US")} words.`;
  return undefined;
};

/** A form whose problems are settled: an artifact form has its node by then. */
const signalFormOf = (form: SignalFormDraft): StoredSignalForm => {
  if (form.kind !== "artifact") return form;
  if (form.node === undefined) throw new Error("an artifact form is finished only once its node is picked");
  const title = form.title?.trim() ?? "";
  const labels = artifactLabelsOf((form.labels ?? []).filter((label) => label.trim() !== "")) ?? [];
  const words = wholeNumber(form.minWords ?? "");
  return {
    kind: "artifact",
    node: form.node,
    ...(title === "" ? {} : { title }),
    ...(labels.length === 0 ? {} : { labels }),
    ...(words === undefined ? {} : { minWords: words }),
  };
};

const FIRED_NEEDS_ARTIFACT = "Only an artifact trigger has an artifact that fired. Pick one artifact.";

const actionProblem = (
  action: ActionDraft,
  carried: ReadonlyArray<string>,
  afterCode: boolean,
  /** Whether the trigger is an artifact change, so "the artifact that fired" means something. */
  artifactFired: boolean,
): string | undefined => {
  switch (action.kind) {
    case "mail":
      if (action.to === undefined) return "Pick who the mail goes to.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "mail") ?? valueProblem(action.text, carried, afterCode);
    case "prompt":
      if (action.to === undefined) return "Pick the seat to prompt.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "prompt") ?? valueProblem(action.text, carried, afterCode);
    case "create-task":
      if (action.node === undefined) return "Pick the task board.";
      return textProblem(action.title, AUTOMATION_NAME_MAX_CHARS, "task title") ?? valueProblem(action.title, carried, afterCode);
    case "assign-task":
      if (action.task === undefined) return "Pick the task to assign.";
      if (action.to === undefined) return "Pick the seat to assign it to.";
      return undefined;
    case "comment":
      if (action.on === undefined) return "Pick what the comment is on.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "comment") ?? valueProblem(action.text, carried, afterCode);
    case "code": {
      const seconds = wholeNumber(action.timeoutSeconds);
      const ms = seconds === undefined ? undefined : seconds * 1000;
      if (ms === undefined || ms < AUTOMATION_CODE_TIMEOUT_MIN_MS || ms > AUTOMATION_CODE_TIMEOUT_MAX_MS)
        return `A code step waits ${AUTOMATION_CODE_TIMEOUT_MIN_MS / 1000} seconds to ${AUTOMATION_CODE_TIMEOUT_MAX_MS / 1000 / 60} minutes.`;
      return action.source === undefined ? "Write the code for this step." : undefined;
    }
    case "create-artifact":
      if (action.node === undefined) return "Pick the Artifacts node.";
      return (
        textProblem(action.title, AUTOMATION_NAME_MAX_CHARS, "artifact title") ??
        valueProblem(action.title, carried, afterCode) ??
        (action.body !== undefined && action.body.trim().length > AUTOMATION_TEXT_MAX_CHARS
          ? `The body is longer than ${AUTOMATION_TEXT_MAX_CHARS} characters.`
          : undefined) ??
        valueProblem(action.body ?? "", carried, afterCode) ??
        labelsProblem((action.labels ?? []).filter((label) => label.trim() !== ""))
      );
    case "append-artifact":
      if (action.to === undefined) return "Pick the artifact to append to.";
      if ("fired" in action.to && !artifactFired) return FIRED_NEEDS_ARTIFACT;
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "text to append") ?? valueProblem(action.text, carried, afterCode);
    case "label-artifact": {
      if (action.to === undefined) return "Pick the artifact to label.";
      if ("fired" in action.to && !artifactFired) return FIRED_NEEDS_ARTIFACT;
      const typed = (labels: ReadonlyArray<string> | undefined) => (labels ?? []).filter((label) => label.trim() !== "");
      const problem = labelsProblem(typed(action.add)) ?? labelsProblem(typed(action.remove));
      if (problem) return problem;
      const add = foldedLabels(action.add);
      const remove = foldedLabels(action.remove);
      if (add.length === 0 && remove.length === 0) return "Name a label to add or remove.";
      const both = add.find((label) => remove.includes(label));
      return both === undefined ? undefined : `${both} is both added and removed. Keep it in one.`;
    }
    case "seat-control":
      return action.seat === undefined ? "Pick the seat to start or stop." : undefined;
    case "signal": {
      const detail = action.detail ?? "";
      return (
        textProblem(action.title, AGENT_SIGNAL_MAX_TEXT_LENGTH, "signal title") ??
        valueProblem(action.title, carried, afterCode) ??
        (detail.trim().length > AGENT_SIGNAL_MAX_DETAIL_LENGTH ? `The detail is longer than ${AGENT_SIGNAL_MAX_DETAIL_LENGTH} characters.` : undefined) ??
        valueProblem(detail, carried, afterCode) ??
        ((action.show ?? []).some((shown) => shown.kind !== "artifact") ? "A signal shows artifacts only." : undefined) ??
        (signalTakesForm(action.signal) ? signalFormProblem(action.form) : undefined)
      );
    }
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
  const carried = automationValuesOf(draft.trigger);
  /** Whether a code step ran before this action, so it may name `{{code.<field>}}`. */
  let afterCode = false;
  const artifactFired = draft.trigger.kind === "change" && draft.trigger.on.kind === "artifact";
  draft.then.forEach((action, index) => {
    const message = actionProblem(action, carried, afterCode, artifactFired);
    if (message) problems.push({ at: "action", index, message });
    if (action.kind === "code") afterCode = true;
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
      return { kind: "change", on: watchOf(trigger.on) };
    case "webhook":
      return trigger;
    default:
      return trigger satisfies never;
  }
};

/** A watch as the contract takes it: an artifact watch's label folded, and gone when none was typed. */
const watchOf = (watch: WatchDraft): unknown => {
  if (watch.kind !== "artifact") return watch;
  const { label, ...rest } = watch;
  const folded = label === undefined ? undefined : label.trim().toLowerCase();
  return folded === undefined || folded === "" ? rest : { ...rest, label: folded };
};

const actionOf = (action: ActionDraft): unknown => {
  switch (action.kind) {
    case "mail":
    case "prompt":
    case "comment":
      return { ...action, text: action.text.trim() };
    case "create-task":
      return { ...action, title: action.title.trim() };
    case "assign-task":
      return action;
    case "code":
      return {
        kind: "code",
        language: action.language,
        source: action.source,
        timeoutMs: codeTimeoutMs(action.timeoutSeconds),
      };
    case "create-artifact": {
      const body = action.body?.trim() ?? "";
      const labels = foldedLabels(action.labels);
      return {
        kind: action.kind,
        node: action.node,
        title: action.title.trim(),
        ...(body === "" ? {} : { body }),
        ...(labels.length === 0 ? {} : { labels }),
      };
    }
    case "append-artifact":
      // Exactly as written: the heading's blank line and the text's own spacing are the operator's.
      return action;
    case "seat-control":
      return action;
    case "signal": {
      const detail = action.detail?.trim() ?? "";
      const show = action.show ?? [];
      return {
        kind: action.kind,
        ...(action.id === undefined ? {} : { id: action.id }),
        signal: action.signal,
        title: action.title.trim(),
        ...(detail === "" ? {} : { detail }),
        ...(show.length === 0 ? {} : { show }),
        // A form belongs to escalate and blocked: a notice is read and cleared, feedback answered in words.
        ...(action.form === undefined || !signalTakesForm(action.signal) ? {} : { form: signalFormOf(action.form) }),
        ...(action.answerTo === undefined || action.signal === "notice" ? {} : { answerTo: action.answerTo }),
      };
    }
    case "label-artifact": {
      const add = foldedLabels(action.add);
      const remove = foldedLabels(action.remove);
      return {
        kind: action.kind,
        to: action.to,
        ...(add.length === 0 ? {} : { add }),
        ...(remove.length === 0 ? {} : { remove }),
      };
    }
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
    ...(draft.when.length > 0 ? { when: draft.when.map((condition) => ({ ...(watchOf(condition) as object), holds: true })) } : {}),
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

/** A task board or Artifacts node a watch covers whole: any task, or any artifact, in it. */
export type NodeScope = { readonly node: NodeId };
/** How a target, or a node a watch covers whole, is named in a sentence: `@product-feed`, `#42 fix tabs`, `Release`. */
export type NameOf = (ref: TargetRef | NodeScope) => string;

const becomesWords: Readonly<Record<SeatBecomes, string>> = {
  idle: "goes idle",
  working: "starts working",
  attention: "needs you",
  gone: "is gone",
};

const taskWords = (task: TaskTarget | undefined, nameOf: NameOf): string =>
  task === undefined ? "a task" : "kind" in task ? nameOf(task) : `any task on ${nameOf(task)}`;

const artifactWords = (artifact: ArtifactScope | undefined, nameOf: NameOf): string =>
  artifact === undefined ? "an artifact" : "kind" in artifact ? nameOf(artifact) : `any artifact in ${nameOf(artifact)}`;

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
    case "artifact": {
      const label = watch.label?.trim().toLowerCase() || undefined;
      const what = artifactWords(watch.artifact, nameOf);
      if (watch.event === "labelled") return `${what} gains ${label === undefined ? "any label" : `the label ${label}`}`;
      return `${what}${label === undefined ? "" : ` labelled ${label}`} is ${ARTIFACT_EVENT_WORD[watch.event]}`;
    }
    case "signal":
      return `${watch.from ? nameOf(watch.from) : "any seat"} ${signalWords[watch.signal]}`;
    case "answered":
      return `${watch.signal === undefined ? "a signal" : `${watch.signal === "escalate" ? "an" : "a"} ${watch.signal} signal`} it raised is answered`;
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

/**
 * What a schedule or a poll means, in a sentence under its fields: "Runs
 * weekdays 09:00, America/Sao_Paulo." Undefined while the fields do not make a
 * schedule the contract would take, so the sentence never describes one thing
 * while the save refuses another.
 */
export const cadenceWords = (trigger: TriggerDraft): string | undefined => {
  switch (trigger.kind) {
    case "schedule": {
      const timezone = trigger.timezone.trim();
      if (!isValidCronExpression(trigger.cron) || !isKnownTimezone(timezone)) return undefined;
      return `${describeCronExpression(trigger.cron)}, ${timezone}`;
    }
    case "poll": {
      const ms = minutesMs(trigger.everyMinutes);
      if (ms === undefined || ms < POLL_MIN_EVERY_MS || ms > 7 * 24 * 60 * MINUTE_MS) return undefined;
      return ms === MINUTE_MS ? "every minute" : `every ${ms / MINUTE_MS} minutes`;
    }
    default:
      return undefined;
  }
};

/** What each value is, in a few words, beside its name in the Insert value list. */
export const VALUE_WORDS: Readonly<Record<AutomationValue, string>> = {
  "task.title": "the task's title",
  "task.state": "the state it became",
  "task.link": "a link to it",
  "task.assignee": "who it is assigned to",
  "board.title": "the board's name",
  "artifact.title": "the artifact's title",
  "artifact.link": "a link to it",
  "artifacts.title": "the Artifacts node's name",
  "artifact.labels": "its labels, comma separated",
  "seat.name": "the seat's name",
  "seat.state": "the state it became",
  "signal.kind": "escalate, blocked or feedback",
  "signal.from": "the seat that raised it",
  "signal.text": "what it says",
  "fired.at": "when it fired",
  "answer.text": "what the answer says",
  "answer.link": "the document or links it handed in",
  "answer.by": "who answered",
  "answer.at": "when it was answered",
  "signal.title": "the signal's title",
  "signal.link": "a link to the automation that raised it",
};

const artifactTargetWords = (to: ArtifactTarget | undefined, nameOf: NameOf): string =>
  to === undefined ? "an artifact" : "fired" in to ? "the artifact that fired" : nameOf(to);

export const actionWords = (action: ActionDraft, nameOf: NameOf): string => {
  switch (action.kind) {
    case "mail":
      return `mail ${action.to ? nameOf(action.to) : "someone"}`;
    case "prompt":
      return `prompt ${action.to ? nameOf(action.to) : "a seat"}`;
    case "create-task":
      return `create a task${action.assign ? ` for ${nameOf(action.assign)}` : ""}`;
    case "assign-task":
      return `assign ${action.task ? nameOf(action.task) : "a task"} to ${action.to ? nameOf(action.to) : "a seat"}`;
    case "comment":
      return `comment on ${action.on ? nameOf(action.on) : "a task, artifact or page"}`;
    case "code":
      return `run ${action.language === "typescript" ? "TypeScript" : "shell"} code`;
    case "create-artifact":
      return `create an artifact${action.node ? ` in ${nameOf({ node: action.node })}` : ""}`;
    case "append-artifact":
      return `append to ${artifactTargetWords(action.to, nameOf)}`;
    case "label-artifact":
      return `label ${artifactTargetWords(action.to, nameOf)}`;
    case "seat-control":
      return `${action.op} ${action.seat ? nameOf(action.seat) : "a seat"}`;
    case "signal":
      return action.signal === "notice" ? "raise a notice" : `raise ${action.signal === "escalate" ? "an escalate" : action.signal}`;
    default:
      return action satisfies never;
  }
};

export const ACTION_LABEL: Readonly<Record<ActionKind, string>> = {
  mail: "Send mail",
  prompt: "Prompt a seat",
  "create-task": "Create a task",
  "assign-task": "Assign a task",
  comment: "Comment",
  code: "Run code",
  "create-artifact": "Create an artifact",
  "append-artifact": "Append to an artifact",
  "label-artifact": "Label an artifact",
  "seat-control": "Start or stop a seat",
  signal: "Raise a signal",
};

export const TRIGGER_LABEL: Readonly<Record<EditableTriggerKind, string>> = {
  schedule: "On a schedule",
  poll: "Every few minutes",
  change: "When something changes",
};

/** What a watch is on, as the sentence's subject: "When a task in Release becomes done". */
export const WATCH_LABEL: Readonly<Record<WatchKind, string>> = {
  seat: "a seat",
  task: "a task",
  artifact: "an artifact",
  signal: "a signal",
  answered: "an automation's signal",
};

/**
 * A watch is a trigger, read "becomes", or a condition, read "is": the state
 * a seat comes to as the trigger fires, or holds as a condition is checked.
 */
export type WatchMode = "becomes" | "is";

const seatStateWords: Readonly<Record<WatchMode, Readonly<Record<SeatBecomes, string>>>> = {
  becomes: becomesWords,
  is: { idle: "is idle", working: "is working", attention: "needs you", gone: "is gone" },
};

/** A seat state as the sentence's verb: "goes idle" as it fires, "is idle" as it holds. */
export const seatStateWord = (state: SeatBecomes, mode: WatchMode): string => seatStateWords[mode][state];

/** A task state as the sentence's last word: "in review". */
export const taskStateWord = (state: TaskBecomes): string => state.replace("-", " ");

export const ARTIFACT_EVENT_WORD: Readonly<Record<ArtifactEvent, string>> = {
  edited: "edited",
  commented: "commented on",
  labelled: "labelled",
};

/** A signal as the sentence's verb: "When a signal from any seat says blocked". */
export const SIGNAL_WORD: Readonly<Record<WatchedSignal, string>> = {
  blocked: "says blocked",
  escalate: "escalates",
  feedback: "says ready for review",
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
const durationWords = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

/**
 * A code step's ruling in words: what it answered, or why it stopped or
 * failed. Undefined for a ruling that is not a code step's, so a caller can
 * pick the code steps out of a firing.
 */
export const codeRulingWords = (ruling: ActionRuling): string | undefined => {
  switch (ruling.ruling) {
    case "continued": {
      const fields = Object.keys(ruling.output);
      return `answered ${fields.length === 0 ? "no values" : fields.map((name) => `{{code.${name}}}`).join(", ")} in ${durationWords(ruling.durationMs)}`;
    }
    case "stopped":
      return ruling.reason === undefined ? `stopped the automation in ${durationWords(ruling.durationMs)}` : `stopped: ${ruling.reason}`;
    case "failed":
      return `failed: ${ruling.message}${ruling.exitCode === undefined ? "" : ` (exit ${ruling.exitCode})`}`;
    case "applied":
    case "queued":
    case "raised":
    case "refused":
      return undefined;
    default:
      return ruling satisfies never;
  }
};

/** A signal's own sentence, short enough for a history line. */
const signalTextWords = (text: string): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  const clipped = [...flat].slice(0, 72).join("").trim();
  return `"${clipped}${[...flat].length > 72 ? "..." : ""}"`;
};

/**
 * A signal step's ruling in words, with what became of the signal it raised:
 * `raised "Write 500 words", answered 09:12 with "Morning pages"`. The
 * ruling says which signal; its state and answer are the signal's own row,
 * so a dismissal or an answer a month later still reads right here. A
 * signal this window does not hold is named as such, never guessed at.
 */
export const signalRulingWords = (
  ruling: ActionRuling,
  signal: AgentSignal | undefined,
  atWords: (at: number) => string,
): string | undefined => {
  if (ruling.ruling !== "raised") return undefined;
  if (signal === undefined) return "raised a signal this window does not hold";
  const raised = `raised ${signalTextWords(signal.text)}`;
  switch (signal.state) {
    case "open":
      return `${raised}, still open`;
    case "dismissed":
      return `${raised}, dismissed${signal.closedAt === undefined ? "" : ` ${atWords(signal.closedAt)}`}`;
    case "withdrawn":
      return `${raised}, withdrawn${signal.closedAt === undefined ? "" : ` ${atWords(signal.closedAt)}`}`;
    case "answered": {
      const response = signal.response;
      if (response === undefined) return `${raised}, answered`;
      const answered = `${raised}, answered ${atWords(response.at)}`;
      if (response.artifact !== undefined) return `${answered} with "${response.artifact.title}"`;
      if (response.links !== undefined && response.links.length > 0) return `${answered} with proof`;
      if (response.attachments !== undefined && response.attachments.length > 0) return `${answered} with proof`;
      if (response.secret !== undefined) return `${answered} with the secret ${response.secret.name}`;
      return answered;
    }
    default:
      return signal.state satisfies never;
  }
};

export const firingWords = (firing: Firing): string => {
  const cause = causeWords(firing.cause);
  switch (firing.outcome.kind) {
    case "fired": {
      const actions = firing.outcome.actions;
      const count = (ruling: ActionRuling["ruling"]): number => actions.filter((action) => action.ruling === ruling).length;
      const queued = count("queued");
      const refused = count("refused");
      const stopped = count("stopped");
      const failed = count("failed");
      // A code step that continued did its part: it acted, as an applied action did.
      return [
        `${cause}, fired, ${count("applied") + count("continued") + count("raised")} of ${actions.length} ${actions.length === 1 ? "action" : "actions"} applied`,
        ...(queued > 0 ? [`${queued} queued`] : []),
        ...(refused > 0 ? [`${refused} refused`] : []),
        ...(stopped > 0 ? [`${stopped} stopped`] : []),
        ...(failed > 0 ? [`${failed} failed`] : []),
      ].join(", ");
    }
    case "skipped":
      return `${cause}, skipped: ${skipWords[firing.outcome.reason]}`;
    // Claimed and never settled: the run died before its actions were ruled. It still counts toward the hourly limit.
    case "claimed":
      return `${cause}, interrupted before its actions were ruled`;
    default:
      return firing.outcome satisfies never;
  }
};

/** Newest first, a stable order for equal times. */
export const historyOrder = (firings: ReadonlyArray<Firing>): ReadonlyArray<Firing> =>
  [...firings].sort((a, b) => b.at - a.at || (a.firingId < b.firingId ? 1 : a.firingId > b.firingId ? -1 : 0));

