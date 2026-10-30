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
  answerToValuesOf,
  automationValuesOf,
  formatProblem,
  isCodeValueName,
  isRaisedValueName,
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
  type StepId,
  type Trigger,
  type Watch,
  type WatchedSignal,
} from "@shared/automation";
import { AGENT_SIGNAL_MAX_DETAIL_LENGTH, AGENT_SIGNAL_MAX_TEXT_LENGTH } from "@shared/wire/agent-signals";
import { ARTIFACT_MAX_TITLE_LENGTH } from "@shared/artifact";
import { parseValueFormat, VALUE_FORMATS } from "@shared/automation-formats";
import type { Refusal, RefusalReason } from "@shared/resource-command";
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
type ArtifactMentionId = Extract<TargetRef, { readonly kind: "artifact" }>["artifactId"];
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
type AnsweredWatch = Extract<Watch, { readonly kind: "answered" }>;
/** The automation an answered watch names: the one whose signal comes back answered. */
export type RaisingAutomation = AnsweredWatch["automation"];

/**
 * Where a signal's answer goes (0.11/09), as the editor holds it: a seat it
 * prompts, a new document in an Artifacts node, or the end of an artifact.
 * The target is unpicked until picked; a document's title as typed.
 */
export type AnswerToDraft =
  | { readonly kind: "seat"; readonly to?: TargetRef }
  | { readonly kind: "document"; readonly node?: NodeId; readonly title: string }
  | { readonly kind: "append"; readonly to?: TargetRef };
export type AnswerToKind = AnswerToDraft["kind"];
export const ANSWER_TO_KINDS: ReadonlyArray<AnswerToKind> = ["seat", "document", "append"];

/** A new answer target of one kind; a document starts titled by the signal and the day it was answered. */
export const blankAnswerTo = (kind: AnswerToKind): AnswerToDraft => {
  switch (kind) {
    case "seat":
      return { kind };
    case "document":
      return { kind, title: "{{signal.title}} {{answer.at|date:YYYY-MM-DD}}" };
    case "append":
      return { kind };
    default:
      return kind satisfies never;
  }
};

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
      /** Where its answer goes besides the feed; never for a notice. */
      readonly answerTo?: AnswerToDraft;
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

// ── Answered back (0.11/09) ────────────────────────────────────────────────

const STEP_ID_MAX = 32;
/** A value token in a title, left out of the step id minted from it. */
const VALUE_TOKEN_TEXT = /\{\{[^{}]*\}\}/gu;

/**
 * A signal step's id, minted from its title the first time something links
 * to it: the title's words as a slug, values left out, "signal" for a title
 * with no words, and a number after it when another signal step has it.
 */
export const mintStepId = (draft: AutomationDraft, index: number): StepId => {
  const action = draft.then[index];
  if (action?.kind === "signal" && action.id !== undefined) return action.id;
  const taken = new Set(draft.then.flatMap((other, at) => (other.kind === "signal" && other.id !== undefined && at !== index ? [other.id] : [])));
  const title = action?.kind === "signal" ? action.title : "";
  const words = title
    .replace(VALUE_TOKEN_TEXT, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  // Room for a number after it, so a second one stays within the bound.
  const base = words.slice(0, STEP_ID_MAX - 4).replace(/-+$/u, "") || "signal";
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
};

/** The draft with this signal step named, and its id; a step that has one keeps it, and the draft is the same draft. */
export const withStepId = (draft: AutomationDraft, index: number): { readonly draft: AutomationDraft; readonly id: StepId } | undefined => {
  const action = draft.then[index];
  if (action?.kind !== "signal") return undefined;
  if (action.id !== undefined) return { draft, id: action.id };
  const id = mintStepId(draft, index);
  return { draft: { ...draft, then: replaceAt(draft.then, index, { ...action, id }) }, id };
};

/** A title on one line, clipped to `max` characters with an ellipsis. */
const clipped = (text: string, max: number): string => {
  const flat = text.replace(/\s+/gu, " ").trim();
  return [...flat].length <= max ? flat : `${[...flat].slice(0, max - 1).join("").trimEnd()}…`;
};

/**
 * A new automation that runs when one signal step is answered: the step's
 * own "When answered…". Its trigger names the raising automation and the
 * step by id; it starts off, with one action to fill in.
 */
export const newAnsweredDraft = (
  automationId: AutomationId,
  nodeId: NodeId,
  author: AutomationAuthor,
  raising: RaisingAutomation,
  step: StepId,
  signalTitle: string,
): AutomationDraft => {
  const title = signalTitle.trim();
  const opening = "When ";
  const closing = " is answered";
  const room = AUTOMATION_NAME_MAX_CHARS - opening.length - closing.length - 2;
  return {
    ...newDraft(automationId, nodeId, author),
    name: title === "" ? "When its signal is answered" : `${opening}"${clipped(title, room)}"${closing}`,
    trigger: { kind: "change", on: { kind: "answered", automation: raising, step } },
  };
};

const sameRaising = (a: RaisingAutomation, b: RaisingAutomation): boolean => a.node === b.node && a.automationId === b.automationId;

/**
 * Whether an answered watch hears this signal step: it names the step's
 * automation, and the step and the kind when it narrows to them. A notice
 * is never answered, so nothing hears it.
 */
export const answeredWatchHears = (
  watch: AnsweredWatch,
  raising: RaisingAutomation,
  step: { readonly id?: StepId; readonly signal: SignalRaise },
): boolean =>
  step.signal !== "notice" &&
  sameRaising(watch.automation, raising) &&
  (watch.step === undefined || watch.step === step.id) &&
  (watch.signal === undefined || watch.signal === step.signal);

/** The automations that run when this signal step is answered, as their trigger says: the two shown as linked. */
export const answeringAutomations = (
  automations: ReadonlyArray<Automation>,
  draft: Pick<AutomationDraft, "nodeId" | "automationId" | "then">,
  index: number,
): ReadonlyArray<Automation> => {
  const step = draft.then[index];
  if (step?.kind !== "signal") return [];
  const raising = { node: draft.nodeId, automationId: draft.automationId };
  return automations.filter(
    (automation) =>
      automation.automationId !== draft.automationId &&
      automation.trigger.kind === "change" &&
      automation.trigger.on.kind === "answered" &&
      answeredWatchHears(automation.trigger.on, raising, step),
  );
};

/** The signal steps an answered watch may narrow to: the ones with an id, a notice never. */
export const answerableSteps = (
  automation: Pick<Automation, "then">,
): ReadonlyArray<{ readonly id: StepId; readonly title: string; readonly signal: WatchedSignal }> =>
  automation.then.flatMap((action) =>
    action.kind === "signal" && action.id !== undefined && action.signal !== "notice"
      ? [{ id: action.id, title: action.title, signal: action.signal }]
      : [],
  );

/** Whether an automation raises any signal that comes back answered, so an answered watch may name it. */
export const raisesAnswerable = (automation: Pick<Automation, "then">): boolean =>
  automation.then.some((action) => action.kind === "signal" && action.signal !== "notice");

/** The raising firing's values an answered trigger carries, `raised.<name>`: what the raising automation's own trigger carries. */
export const raisedValuesOf = (raising: Pick<Automation, "trigger"> | undefined): ReadonlyArray<string> =>
  raising === undefined ? [] : automationValuesOf(raising.trigger).map((name) => `raised.${name}`);

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

/** What an action's text may name where it stands: its trigger's values, code fields after a code step, the raising firing's. */
type ValueScope = {
  readonly carried: ReadonlyArray<string>;
  /** What an answer's document title may name: the step's own values, then the answer's. */
  readonly answerCarried: ReadonlyArray<string>;
  /** Whether a code step ran before this action, so it may name `{{code.<field>}}`. */
  readonly afterCode: boolean;
  /** Whether the trigger is an answered watch, so a text may name `{{raised.<name>}}`. */
  readonly answered: boolean;
  /** Whether the trigger is an artifact change, so "the artifact that fired" means something. */
  readonly artifactFired: boolean;
};

/** A refusal as one or two sentences under its field. */
const refusalSentences = (refusal: Refusal): string => {
  const message = `${refusal.message.charAt(0).toUpperCase()}${refusal.message.slice(1)}.`;
  return refusal.next_step === undefined ? message : `${message} ${refusal.next_step}.`;
};

/**
 * A format the set does not hold, or a value the trigger does not carry, at
 * the action that writes it: main refuses the same at save (`valueRefusal`),
 * and the editor says it before the round trip, in the same words.
 */
const valueProblem = (text: string, scope: ValueScope, carried: ReadonlyArray<string> = scope.carried): string | undefined => {
  const formats = formatProblem(text);
  if (formats !== undefined) return refusalSentences(formats);
  const missing = valueNamesIn(text).find(
    (name) => !carried.includes(name) && !(scope.afterCode && isCodeValueName(name)) && !(scope.answered && isRaisedValueName(name)),
  );
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

/** Where the answer goes, once its problems are settled: the target picked, the title trimmed. */
const answerToOf = (answerTo: AnswerToDraft): unknown =>
  answerTo.kind === "document" ? { kind: answerTo.kind, node: answerTo.node, title: answerTo.title.trim() } : answerTo;

const FIRED_NEEDS_ARTIFACT = "Only an artifact trigger has an artifact that fired. Pick one artifact.";

/** Where the answer goes, settled: its target picked, a document's title written. */
const answerToProblem = (answerTo: AnswerToDraft | undefined, scope: ValueScope): string | undefined => {
  switch (answerTo?.kind) {
    case undefined:
      return undefined;
    case "seat":
      return answerTo.to?.kind === "seat" ? undefined : "Pick the seat the answer goes to.";
    case "document":
      if (answerTo.node === undefined) return "Pick the Artifacts node the answer is written in.";
      return textProblem(answerTo.title, ARTIFACT_MAX_TITLE_LENGTH, "answer document's title") ?? valueProblem(answerTo.title, scope, scope.answerCarried);
    case "append":
      return answerTo.to?.kind === "artifact" ? undefined : "Pick the artifact the answer is added to.";
    default:
      return answerTo satisfies never;
  }
};

const actionProblem = (action: ActionDraft, scope: ValueScope): string | undefined => {
  const { artifactFired } = scope;
  switch (action.kind) {
    case "mail":
      if (action.to === undefined) return "Pick who the mail goes to.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "mail") ?? valueProblem(action.text, scope);
    case "prompt":
      if (action.to === undefined) return "Pick the seat to prompt.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "prompt") ?? valueProblem(action.text, scope);
    case "create-task":
      if (action.node === undefined) return "Pick the task board.";
      return textProblem(action.title, AUTOMATION_NAME_MAX_CHARS, "task title") ?? valueProblem(action.title, scope);
    case "assign-task":
      if (action.task === undefined) return "Pick the task to assign.";
      if (action.to === undefined) return "Pick the seat to assign it to.";
      return undefined;
    case "comment":
      if (action.on === undefined) return "Pick what the comment is on.";
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "comment") ?? valueProblem(action.text, scope);
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
        valueProblem(action.title, scope) ??
        (action.body !== undefined && action.body.trim().length > AUTOMATION_TEXT_MAX_CHARS
          ? `The body is longer than ${AUTOMATION_TEXT_MAX_CHARS} characters.`
          : undefined) ??
        valueProblem(action.body ?? "", scope) ??
        labelsProblem((action.labels ?? []).filter((label) => label.trim() !== ""))
      );
    case "append-artifact":
      if (action.to === undefined) return "Pick the artifact to append to.";
      if ("fired" in action.to && !artifactFired) return FIRED_NEEDS_ARTIFACT;
      return textProblem(action.text, AUTOMATION_TEXT_MAX_CHARS, "text to append") ?? valueProblem(action.text, scope);
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
        valueProblem(action.title, scope) ??
        (detail.trim().length > AGENT_SIGNAL_MAX_DETAIL_LENGTH ? `The detail is longer than ${AGENT_SIGNAL_MAX_DETAIL_LENGTH} characters.` : undefined) ??
        valueProblem(detail, scope) ??
        ((action.show ?? []).some((shown) => shown.kind !== "artifact") ? "A signal shows artifacts only." : undefined) ??
        (signalTakesForm(action.signal) ? signalFormProblem(action.form) : undefined) ??
        (action.signal === "notice" ? undefined : answerToProblem(action.answerTo, scope))
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
  let scope: ValueScope = {
    carried: automationValuesOf(draft.trigger),
    answerCarried: answerToValuesOf(draft.trigger),
    afterCode: false,
    answered: draft.trigger.kind === "change" && draft.trigger.on.kind === "answered",
    artifactFired: draft.trigger.kind === "change" && draft.trigger.on.kind === "artifact",
  };
  draft.then.forEach((action, index) => {
    const message = actionProblem(action, scope);
    if (message) problems.push({ at: "action", index, message });
    if (action.kind === "code") scope = { ...scope, afterCode: true };
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
        // A notice is read and cleared: no answer comes back to send anywhere.
        ...(action.answerTo === undefined || action.signal === "notice" ? {} : { answerTo: answerToOf(action.answerTo) }),
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
/** An automation an answered watch names, by its name, or undefined when this window does not hold it. */
export type AutomationNameOf = (automation: RaisingAutomation) => string | undefined;

/** A signal kind as the subject of "is answered", in the list's sentence and the trigger's picker alike: "an escalation". */
export const ANSWERED_KIND_WORDS: Readonly<Record<WatchedSignal, string>> = {
  escalate: "an escalation",
  blocked: "a blocked signal",
  feedback: "a feedback signal",
};

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

export const watchWords = (watch: WatchDraft, nameOf: NameOf, automationNameOf?: AutomationNameOf): string => {
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
    case "answered": {
      const from = automationNameOf?.(watch.automation) ?? "another automation";
      return `${watch.signal === undefined ? "a signal" : ANSWERED_KIND_WORDS[watch.signal]} from ${from} is answered`;
    }
    default:
      return watch satisfies never;
  }
};

/** The trigger in a few words, for the sidebar row and the pane's header. */
export const triggerWords = (trigger: TriggerDraft, nameOf: NameOf, automationNameOf?: AutomationNameOf): string => {
  switch (trigger.kind) {
    case "schedule":
      return `${describeCronExpression(trigger.cron)}, ${trigger.timezone}`;
    case "poll": {
      const ms = minutesMs(trigger.everyMinutes);
      return ms === undefined ? "polls" : ms === MINUTE_MS ? "every minute" : `every ${ms / MINUTE_MS} minutes`;
    }
    case "change":
      return `when ${watchWords(trigger.on, nameOf, automationNameOf)}`;
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

/** A value's words in the Insert value list; a raised one is the raising firing's, said when it was raised. */
export const valueWords = (name: string): string => {
  const inner = name.startsWith("raised.") ? name.slice("raised.".length) : name;
  const words = (VALUE_WORDS as Readonly<Record<string, string>>)[inner] ?? "a value";
  return inner === name ? words : `${words}, as it was when the signal was raised`;
};

/** A format the Format value list offers: what is written after the value's `|`, and what it does. */
export type FormatChoice = { readonly format: string; readonly words: string };

/**
 * The formats Format value offers, one for each in the closed set and three
 * common date patterns; any other pattern is typed by hand. A date is
 * written in the automation's time zone.
 */
export const FORMAT_CHOICES: ReadonlyArray<FormatChoice> = [
  { format: "date:YYYY-MM-DD", words: "a time as its day, 2027-03-04" },
  { format: "date:YYYY-MM-DD HH:mm", words: "a time to the minute, 2027-03-04 09:30" },
  { format: "date:HH:mm", words: "a time of day, 09:30" },
  { format: "slug", words: "lower case, dashes between words" },
  { format: "lower", words: "lower case" },
  { format: "upper", words: "upper case" },
  { format: "trim", words: "no spaces at either end" },
];

/** The closed set's own names, so a test holds that every one is offered: `date:<pattern>` is `date`. */
export const VALUE_FORMAT_KINDS: ReadonlyArray<string> = VALUE_FORMATS.map((format) => format.split(":")[0]!);
export const formatChoiceKind = (choice: FormatChoice): string | undefined => parseValueFormat(choice.format)?.kind;

const TOKEN_AT = /\{\{[^{}]*\}\}/gu;

/** Whether a text holds a value for a format to go on. */
export const hasValueToken = (text: string): boolean => /\{\{[^{}]*\}\}/u.test(text);

/**
 * A format added to one value in a text: the value the caret is in or just
 * after, else the last before the caret, else the first. The format goes
 * last, before the closing braces, and the caret after them. Undefined when
 * the text holds no value.
 */
export const withFormat = (
  text: string,
  caret: number,
  format: string,
): { readonly text: string; readonly caret: number } | undefined => {
  const tokens = [...text.matchAll(TOKEN_AT)].map((match) => ({ start: match.index, end: match.index + match[0].length }));
  if (tokens.length === 0) return undefined;
  const token =
    tokens.find((candidate) => candidate.start < caret && caret <= candidate.end) ??
    tokens.filter((candidate) => candidate.end <= caret).at(-1) ??
    tokens[0]!;
  const written = `|${format}`;
  const at = token.end - 2;
  return { text: `${text.slice(0, at)}${written}${text.slice(at)}`, caret: token.end + written.length };
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

/** What a refusal's reason says after a step's name, so a line reads "Send mail is not available on Mac mini". */
const stepRefusalWords: Readonly<Record<RefusalReason, string>> = {
  not_in_reach: "is outside its reach",
  not_permitted: "is not permitted",
  unknown_target: "targets something that is gone",
  invalid_input: "has values that are not valid",
  invalid_transition: "cannot do that now",
  already_held: "is held elsewhere",
  reviewer_is_author: "cannot name its author as reviewer",
  stale: "was written against an older version",
  rebase_conflict: "conflicts with a newer edit",
  depends_on_refused: "depends on a step that was refused",
  not_available: "is not available",
  queue_full: "waits on a full queue",
};

/** What a step line needs to name a machine and the step it speaks of. */
export type StepWordsContext = {
  readonly atWords: (at: number) => string;
  /** How a machine is named to the operator; the raw host id by default. */
  readonly nameMachine?: (host: string) => string;
  /** The step's label from the automation's actions by index, such as "Send mail". */
  readonly label?: string;
  /** The machine that ran the firing, named, when it did not run here. */
  readonly elsewhere?: string;
};

/**
 * A step's line while its automation's machine was not linked (0.12 S3):
 * an action still waiting names the machine and since when; one that waited
 * and then went says both; a refused step names the step and why, and a move
 * mid-firing says where the automation went. Undefined for a ruling that
 * says nothing more than the firing's own line, or that a code step or a
 * signal step already says in its own words.
 */
export const heldRulingWords = (ruling: ActionRuling, words: StepWordsContext): string | undefined => {
  const nameMachine = words.nameMachine ?? ((host: string) => host);
  switch (ruling.ruling) {
    case "queued":
      return ruling.waitingOn === undefined
        ? "waiting"
        : `waiting for ${nameMachine(ruling.waitingOn.machine)} since ${words.atWords(ruling.waitingOn.since)}`;
    case "applied":
      return ruling.heldSince === undefined ? undefined : `applied after waiting from ${words.atWords(ruling.heldSince)}`;
    case "refused": {
      if (ruling.movedTo !== undefined) return `not run: the automation moved to ${nameMachine(ruling.movedTo)}`;
      const place = words.elsewhere === undefined ? "" : ` on ${words.elsewhere}`;
      return `not run: ${words.label ?? "it"} ${stepRefusalWords[ruling.reason]}${place}`;
    }
    case "raised":
    case "continued":
    case "stopped":
    case "failed":
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
 * `raised "Write 500 words", answered 09:12`; what the answer was follows it
 * (`signalAnswerOf`). The
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
      // What the answer was is `signalAnswerOf`, shown after these words: a link, or the words themselves.
      return `${raised}, answered ${atWords(response.at)}`;
    }
    default:
      return signal.state satisfies never;
  }
};

/**
 * What the operator answered a signal with, as its history row shows it
 * (0.11/09 decision 1, the signal and its answer): a handed-in document as
 * its artifact to open, proof, a secret only as given and never by its
 * value, or the reply's own words. Undefined until it is answered, or for
 * an answer with nothing in it.
 */
export type SignalAnswerShown =
  | { readonly kind: "document"; readonly artifact: Extract<TargetRef, { readonly kind: "artifact" }>; readonly title: string }
  | { readonly kind: "proof" }
  | { readonly kind: "secret" }
  | { readonly kind: "words"; readonly text: string };

export const signalAnswerOf = (signal: AgentSignal | undefined): SignalAnswerShown | undefined => {
  const response = signal?.state === "answered" ? signal.response : undefined;
  if (response === undefined) return undefined;
  if (response.artifact !== undefined) {
    const { nodeId, artifactId, title } = response.artifact;
    return { kind: "document", artifact: { kind: "artifact", nodeId: nodeId as NodeId, artifactId: artifactId as ArtifactMentionId }, title };
  }
  if ((response.links?.length ?? 0) > 0 || (response.attachments?.length ?? 0) > 0) return { kind: "proof" };
  if (response.secret !== undefined) return { kind: "secret" };
  const text = response.text.trim();
  return text === "" ? undefined : { kind: "words", text };
};

/** Past this many characters, or with a line break, a reply's words show cut to two lines with the rest a press away. */
export const ANSWER_SHORT_MAX = 160;
export const answerIsLong = (text: string): boolean => text.length > ANSWER_SHORT_MAX || text.includes("\n");

/**
 * One line of the firing history: `Scheduled, fired, 2 of 2 steps applied`.
 * A firing that ran on another machine says where, by the label the operator
 * reads: `Scheduled, fired on Mac mini, 2 of 2 steps applied`. `here` is this
 * machine's short name, empty until settings load, when no machine is named;
 * a firing that names none stays local.
 */
export const firingWords = (
  firing: Firing,
  here?: string,
  nameMachine: (host: string) => string = (host) => host,
): string => {
  const elsewhere =
    firing.machine === undefined || here === undefined || here === "" || firing.machine === here
      ? undefined
      : nameMachine(firing.machine);
  const ran = elsewhere === undefined ? "" : ` on ${elsewhere}`;
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
        `${cause}, fired${ran}, ${count("applied") + count("continued") + count("raised")} of ${actions.length} ${actions.length === 1 ? "step" : "steps"} applied`,
        ...(queued > 0 ? [`${queued} queued`] : []),
        ...(refused > 0 ? [`${refused} refused`] : []),
        ...(stopped > 0 ? [`${stopped} stopped`] : []),
        ...(failed > 0 ? [`${failed} failed`] : []),
      ].join(", ");
    }
    case "skipped":
      return `${cause}, skipped${ran}: ${skipWords[firing.outcome.reason]}`;
    // Claimed and never settled: the run died before its actions were ruled. It still counts toward the hourly limit.
    case "claimed":
      return `${cause}, interrupted${ran} before its steps were ruled`;
    default:
      return firing.outcome satisfies never;
  }
};

/**
 * Newest first by firing id alone. A firing mints its ULID on the machine it
 * runs on, and only that machine writes its later revisions, so this order is
 * stable when two machines' clocks disagree and a settle stays where it began.
 */
export const historyOrder = (firings: ReadonlyArray<Firing>): ReadonlyArray<Firing> =>
  [...firings].sort((a, b) => (a.firingId < b.firingId ? 1 : a.firingId > b.firingId ? -1 : 0));

