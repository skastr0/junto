/**
 * The Automations node's main pane (plan 0.10/07): one automation's
 * definition, edited as a draft. Trigger, conditions, actions and limits,
 * each a section; targets are picked with MentionCombobox from what the
 * automation may reach (`useAutomationTargets`). Nothing leaves the pane
 * until `finishDraft` passes it, and a save carries the version it was
 * edited from.
 */
import { useId, useMemo, useState, type ReactNode, type Ref } from "react";
import { ArrowDown, ArrowUp, Plus, X } from "lucide-react";
import { mentionKey, mentionLink, type MentionRef } from "@shared/mention";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import { automationTargets } from "@shared/region-reach";
import {
  ACTION_LABEL,
  ARTIFACT_EVENTS,
  SEAT_BECOMES,
  SIGNALS,
  TASK_BECOMES,
  TRIGGER_LABEL,
  WATCH_LABEL,
  blankWatch,
  draftProblems,
  editDraft,
  type ActionDraft,
  type ActionKind,
  type AutomationDraft,
  type ConditionDraft,
  type DraftEdit,
  type DraftProblem,
  type EditableTriggerKind,
  type NameOf,
  type TriggerDraft,
  type WatchDraft,
} from "../../lib/automation-editor";
import type { MentionCandidate, MentionTrigger } from "../../lib/mention-draft";
import { useMentionItems } from "../../lib/mention-items";
import { useAutomationTargets } from "../../lib/mention-sources";
import { useCanvas } from "../../lib/use-model";
import { useTargetNames } from "../../lib/automation-names";
import { Button, FieldLabel, IconButton, Input, Select, Switch } from "../ui";
import { MentionCombobox } from "../ui/MentionCombobox";

type TargetKind = MentionRef["kind"];

const LIST_LABEL = (trigger: MentionTrigger): string =>
  trigger === "@" ? "Seats and pages this automation may name" : "Tasks and artifacts this automation may name";

/** One target, picked by typing @ or #. Shows the picked one back as its chip. */
function TargetPicker<K extends TargetKind>({
  value,
  onChange,
  kinds,
  candidates,
  canvasName,
  nameOf,
  label,
  placeholder,
}: {
  readonly value: Extract<MentionRef, { readonly kind: K }> | undefined;
  readonly onChange: (ref: Extract<MentionRef, { readonly kind: K }> | undefined) => void;
  readonly kinds: ReadonlyArray<K>;
  readonly candidates: ReadonlyArray<MentionCandidate>;
  readonly canvasName: string;
  readonly nameOf: NameOf;
  readonly label: string;
  readonly placeholder: string;
}) {
  const offered = useMemo(
    () => candidates.filter((candidate) => (kinds as ReadonlyArray<TargetKind>).includes(candidate.ref.kind)),
    [candidates, kinds],
  );
  const written = value === undefined ? "" : mentionLink(value, nameOf(value), canvasName);
  // Typed text that names nothing yet stays in the field; the draft holds only a picked target.
  const [typing, setTyping] = useState<string>();
  return (
    <MentionCombobox
      dense
      rows={1}
      value={typing ?? written}
      canvasName={canvasName}
      candidates={offered}
      listLabel={LIST_LABEL}
      noun={{ one: "target", other: "targets" }}
      maxMentions={1}
      aria-label={label}
      placeholder={placeholder}
      onValueChange={(next, mentions) => {
        const picked = mentions.find((ref): ref is Extract<MentionRef, { readonly kind: K }> =>
          (kinds as ReadonlyArray<TargetKind>).includes(ref.kind),
        );
        setTyping(picked === undefined ? next : undefined);
        if (picked === undefined ? value !== undefined : value === undefined || mentionKey(picked) !== mentionKey(value)) {
          onChange(picked);
        }
      }}
    />
  );
}

const options = <T extends string>(values: ReadonlyArray<T>, words: (value: T) => string = (value) => value.replace("-", " ")) =>
  values.map((value) => ({ value, label: words(value) }));

const problemAt = (problems: ReadonlyArray<DraftProblem>, match: (problem: DraftProblem) => boolean): string | undefined =>
  problems.find(match)?.message;

function Section({
  title,
  children,
  actions,
  describedBy,
}: {
  readonly title: string;
  readonly children: ReactNode;
  readonly actions?: ReactNode;
  /** The id of this section's problem, when it has one. */
  readonly describedBy?: string;
}) {
  return (
    <section className="automation-editor__section" aria-label={title} aria-describedby={describedBy}>
      <header className="automation-editor__section-head">
        <h3 className="automation-editor__section-title">{title}</h3>
        {actions}
      </header>
      {children}
    </section>
  );
}

/**
 * A field's problem, shown once a save was tried. Quiet: the footer's status
 * says how many there are, and the field or group it belongs to names it as
 * its description, so a screen reader hears it where it is.
 */
function Problem({ id, message }: { readonly id: string; readonly message: string | undefined }) {
  return message ? (
    <p id={id} className="automation-editor__problem">
      {message}
    </p>
  ) : null;
}

type Pickers = {
  readonly candidates: ReadonlyArray<MentionCandidate>;
  readonly canvasName: string;
  readonly nameOf: NameOf;
  readonly boards: ReadonlyArray<{ readonly id: NodeId; readonly title: string }>;
};

/** A watch's fields: what is watched and the state or event it waits for. */
function WatchFields({
  watch,
  onChange,
  pickers,
  conditionOnly,
}: {
  readonly watch: WatchDraft;
  readonly onChange: (watch: WatchDraft) => void;
  readonly pickers: Pickers;
  readonly conditionOnly?: boolean;
}) {
  const kinds = conditionOnly ? (["seat", "task"] as const) : (["seat", "task", "artifact", "signal"] as const);
  return (
    <div className="automation-editor__row">
      <Select
        aria-label="What it watches"
        value={watch.kind}
        options={kinds.map((kind) => ({ value: kind, label: WATCH_LABEL[kind] }))}
        onChange={(kind) => {
          if (kind !== watch.kind) onChange(blankWatch(kind as WatchDraft["kind"]));
        }}
      />
      {watch.kind === "seat" ? (
        <>
          <TargetPicker
            {...pickers}
            kinds={["seat"]}
            label="Seat"
            placeholder="@seat"
            value={watch.seat?.kind === "seat" ? watch.seat : undefined}
            onChange={(seat) => onChange({ ...watch, seat })}
          />
          <Select
            aria-label="Becomes"
            value={watch.becomes}
            options={options(SEAT_BECOMES)}
            onChange={(becomes) => onChange({ ...watch, becomes: becomes as typeof watch.becomes })}
          />
        </>
      ) : null}
      {watch.kind === "task" ? (
        <>
          <Select
            aria-label="Which task"
            value={watch.task !== undefined && !("kind" in watch.task) ? `board:${watch.task.node}` : "one"}
            options={[
              { value: "one", label: "This task" },
              ...pickers.boards.map((board) => ({ value: `board:${board.id}`, label: `Any task on ${board.title}` })),
            ]}
            onChange={(which) =>
              onChange({
                ...watch,
                task: which === "one" ? undefined : { node: which.slice("board:".length) as NodeId },
              })
            }
          />
          {watch.task === undefined || "kind" in watch.task ? (
            <TargetPicker
              {...pickers}
              kinds={["task"]}
              label="Task"
              placeholder="#task"
              value={watch.task?.kind === "task" ? watch.task : undefined}
              onChange={(task) => onChange({ ...watch, task })}
            />
          ) : null}
          <Select
            aria-label="Becomes"
            value={watch.becomes}
            options={options(TASK_BECOMES)}
            onChange={(becomes) => onChange({ ...watch, becomes: becomes as typeof watch.becomes })}
          />
        </>
      ) : null}
      {watch.kind === "artifact" ? (
        <>
          <TargetPicker
            {...pickers}
            kinds={["artifact"]}
            label="Artifact"
            placeholder="#artifact"
            value={watch.artifact?.kind === "artifact" ? watch.artifact : undefined}
            onChange={(artifact) => onChange({ ...watch, artifact })}
          />
          <Select
            aria-label="Event"
            value={watch.event}
            options={options(ARTIFACT_EVENTS)}
            onChange={(event) => onChange({ ...watch, event: event as typeof watch.event })}
          />
        </>
      ) : null}
      {watch.kind === "signal" ? (
        <>
          <TargetPicker
            {...pickers}
            kinds={["seat"]}
            label="From seat, or any"
            placeholder="@seat, or any seat"
            value={watch.from?.kind === "seat" ? watch.from : undefined}
            onChange={(from) => onChange(from === undefined ? { kind: "signal", signal: watch.signal } : { ...watch, from })}
          />
          <Select
            aria-label="Signal"
            value={watch.signal}
            options={options(SIGNALS)}
            onChange={(signal) => onChange({ ...watch, signal: signal as typeof watch.signal })}
          />
        </>
      ) : null}
    </div>
  );
}

function TriggerFields({ trigger, onChange, pickers }: { readonly trigger: TriggerDraft; readonly onChange: (trigger: TriggerDraft) => void; readonly pickers: Pickers }) {
  switch (trigger.kind) {
    case "schedule":
      return (
        <div className="automation-editor__row">
          <FieldLabel>
            Cron
            <Input
              dense
              value={trigger.cron}
              spellCheck={false}
              aria-label="Cron schedule"
              placeholder="0 9 * * 1-5"
              onChange={(event) => onChange({ ...trigger, cron: event.target.value })}
            />
          </FieldLabel>
          <FieldLabel>
            Timezone
            <Input
              dense
              value={trigger.timezone}
              spellCheck={false}
              aria-label="Timezone"
              onChange={(event) => onChange({ ...trigger, timezone: event.target.value })}
            />
          </FieldLabel>
        </div>
      );
    case "poll":
      return (
        <div className="automation-editor__row">
          <FieldLabel>
            Every, in minutes
            <Input
              dense
              inputMode="numeric"
              value={trigger.everyMinutes}
              aria-label="Poll every, in minutes"
              onChange={(event) => onChange({ ...trigger, everyMinutes: event.target.value })}
            />
          </FieldLabel>
        </div>
      );
    case "change":
      return <WatchFields watch={trigger.on} pickers={pickers} onChange={(on) => onChange({ ...trigger, on })} />;
    case "webhook":
      return <p className="automation-editor__note">A webhook trigger. Webhooks are not available yet; pick another trigger above to save.</p>;
    default:
      return trigger satisfies never;
  }
}

function ActionFields({ action, onChange, pickers }: { readonly action: ActionDraft; readonly onChange: (action: ActionDraft) => void; readonly pickers: Pickers }) {
  switch (action.kind) {
    case "mail":
      return (
        <>
          <TargetPicker
            {...pickers}
            kinds={["seat"]}
            label="Mail to"
            placeholder="@seat"
            value={action.to?.kind === "seat" ? action.to : undefined}
            onChange={(to) => onChange({ ...action, to })}
          />
          <Input dense value={action.text} aria-label="Mail text" placeholder="What the mail says" onChange={(event) => onChange({ ...action, text: event.target.value })} />
        </>
      );
    case "create-task":
      return (
        <>
          <Select
            aria-label="Task board"
            placeholder="Pick a task board"
            value={action.node ?? ""}
            options={pickers.boards.map((board) => ({ value: board.id, label: board.title }))}
            onChange={(node) => onChange({ ...action, node: node as NodeId })}
          />
          <Input dense value={action.title} aria-label="Task title" placeholder="Task title" onChange={(event) => onChange({ ...action, title: event.target.value })} />
          <TargetPicker
            {...pickers}
            kinds={["seat"]}
            label="Assign to, optional"
            placeholder="@seat, optional"
            value={action.assign?.kind === "seat" ? action.assign : undefined}
            onChange={(assign) => {
              const { assign: _old, ...rest } = action;
              onChange(assign === undefined ? rest : { ...rest, assign });
            }}
          />
        </>
      );
    case "assign-task":
      return (
        <>
          <TargetPicker
            {...pickers}
            kinds={["task"]}
            label="Task"
            placeholder="#task"
            value={action.task?.kind === "task" ? action.task : undefined}
            onChange={(task) => onChange({ ...action, task })}
          />
          <TargetPicker
            {...pickers}
            kinds={["seat"]}
            label="Assign to"
            placeholder="@seat"
            value={action.to?.kind === "seat" ? action.to : undefined}
            onChange={(to) => onChange({ ...action, to })}
          />
        </>
      );
    case "comment":
      return (
        <>
          <TargetPicker
            {...pickers}
            kinds={["task", "artifact", "page"]}
            label="Comment on"
            placeholder="#task, #artifact or @page"
            value={action.on}
            onChange={(on) => onChange({ ...action, on })}
          />
          <Input dense value={action.text} aria-label="Comment text" placeholder="What the comment says" onChange={(event) => onChange({ ...action, text: event.target.value })} />
        </>
      );
    default:
      return action satisfies never;
  }
}

const ACTION_KINDS = Object.keys(ACTION_LABEL) as ReadonlyArray<ActionKind>;
const TRIGGER_KINDS = Object.keys(TRIGGER_LABEL) as ReadonlyArray<EditableTriggerKind>;

export function AutomationEditor({
  draft,
  onDraft,
  onEnabled,
  canvasName,
  saving,
  saveRef,
  nameRef,
  dirty,
  onSave,
  onRevert,
  refusal,
}: {
  readonly draft: AutomationDraft;
  readonly onDraft: (draft: AutomationDraft) => void;
  /** On and off as its own write; without it the switch edits the draft. */
  readonly onEnabled?: (enabled: boolean) => void;
  readonly canvasName: string;
  readonly saving: boolean;
  /** The Save button, for the pane to return focus to when the control that held it goes away. */
  readonly saveRef?: Ref<HTMLButtonElement>;
  /** The name field, where focus goes when a new automation opens. */
  readonly nameRef?: Ref<HTMLInputElement>;
  readonly dirty: boolean;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  /** Why the last save did not land, in words. */
  readonly refusal?: string;
}) {
  const canvas = useCanvas(canvasName);
  // Task boards and Artifacts nodes offer only the items handed to them: without these every #picker is empty.
  const candidates = useAutomationTargets(canvasName, draft.nodeId, draft.author, useMentionItems(canvasName));
  const nameOf = useTargetNames(candidates, canvasName);
  const boards = useMemo(
    () =>
      automationTargets(canvas, draft.nodeId, draft.author)
        .filter((node) => node.kind === "task")
        .map((node) => ({ id: node.id, title: titleOf(canvas.nodes.get(node.id)!) })),
    [canvas, draft.nodeId, draft.author],
  );
  const pickers: Pickers = { candidates, canvasName, nameOf, boards };
  // Problems show once a save was tried on this automation, not while it is being written.
  const [triedOn, setTriedOn] = useState<string>();
  const tried = triedOn === draft.automationId;
  const problems = tried ? draftProblems(draft) : [];
  const edit = (change: DraftEdit): void => onDraft(editDraft(draft, change));
  const baseId = useId();
  /** The problem's id where there is one, for aria-describedby. */
  const problemId = (part: string, match: (problem: DraftProblem) => boolean): string | undefined =>
    problems.some(match) ? `${baseId}-${part}` : undefined;
  const isName = (problem: DraftProblem): boolean => problem.at === "name";
  const isTrigger = (problem: DraftProblem): boolean => problem.at === "trigger";
  const isActions = (problem: DraftProblem): boolean => problem.at === "actions";
  const isLimits = (problem: DraftProblem): boolean => problem.at === "limits";
  const isCondition = (index: number) => (problem: DraftProblem): boolean => problem.at === "condition" && problem.index === index;
  const isAction = (index: number) => (problem: DraftProblem): boolean => problem.at === "action" && problem.index === index;
  const trySave = (): void => {
    if (draftProblems(draft).length > 0) setTriedOn(draft.automationId);
    else onSave();
  };

  return (
    <div className="automation-editor" data-testid="automation-editor">
      <div className="automation-editor__title">
        <Input
          ref={nameRef}
          value={draft.name}
          aria-label="Automation name"
          aria-describedby={problemId("name", isName)}
          onChange={(event) => edit({ type: "name", name: event.target.value })}
        />
        <label className="automation-editor__enabled">
          <span>{draft.enabled ? "On" : "Off"}</span>
          <Switch
            checked={draft.enabled}
            aria-label="Automation on"
            onCheckedChange={(enabled) => (onEnabled ? onEnabled(enabled) : edit({ type: "enabled", enabled }))}
          />
        </label>
      </div>
      <Problem id={`${baseId}-name`} message={problemAt(problems, isName)} />

      <Section title="Trigger" describedBy={problemId("trigger", isTrigger)}>
        <Select
          aria-label="Trigger"
          // A loaded webhook matches no option, so the field reads as unpicked until another is chosen.
          value={draft.trigger.kind === "webhook" ? "" : draft.trigger.kind}
          placeholder="Webhook, not available yet"
          options={TRIGGER_KINDS.map((kind) => ({ value: kind, label: TRIGGER_LABEL[kind] }))}
          onChange={(kind) => edit({ type: "trigger-kind", kind: kind as EditableTriggerKind })}
        />
        <TriggerFields trigger={draft.trigger} pickers={pickers} onChange={(trigger) => edit({ type: "trigger", trigger })} />
        <Problem id={`${baseId}-trigger`} message={problemAt(problems, isTrigger)} />
      </Section>

      <Section
        title="Only when"
        actions={
          <Button size="xs" variant="subtle" onClick={() => edit({ type: "add-condition", kind: "seat" })}>
            <Plus size={12} aria-hidden />
            Condition
          </Button>
        }
      >
        {draft.when.length === 0 ? <p className="automation-editor__note">No conditions: it fires whenever the trigger does.</p> : null}
        <ol className="automation-editor__list">
          {draft.when.map((condition, index) => (
            <li
              key={draft.whenKeys[index] ?? index}
              className="automation-editor__item"
              role="group"
              aria-label={`Condition ${index + 1}`}
              aria-describedby={problemId(`condition-${index}`, isCondition(index))}
            >
              <WatchFields
                conditionOnly
                watch={condition}
                pickers={pickers}
                onChange={(next) => edit({ type: "condition", index, condition: next as ConditionDraft })}
              />
              <IconButton size="sm" tone="danger" aria-label={`Remove condition ${index + 1}`} onClick={() => edit({ type: "remove-condition", index })}>
                <X size={13} />
              </IconButton>
              <Problem id={`${baseId}-condition-${index}`} message={problemAt(problems, isCondition(index))} />
            </li>
          ))}
        </ol>
      </Section>

      <Section
        title="Then"
        describedBy={problemId("actions", isActions)}
        actions={
          <Button size="xs" variant="subtle" onClick={() => edit({ type: "add-action", kind: "mail" })}>
            <Plus size={12} aria-hidden />
            Action
          </Button>
        }
      >
        <Problem id={`${baseId}-actions`} message={problemAt(problems, isActions)} />
        <ol className="automation-editor__list">
          {draft.then.map((action, index) => (
            <li
              key={draft.thenKeys[index] ?? index}
              className="automation-editor__item"
              role="group"
              aria-label={`Action ${index + 1}`}
              aria-describedby={problemId(`action-${index}`, isAction(index))}
            >
              <div className="automation-editor__row">
                <Select
                  aria-label={`Action ${index + 1}`}
                  value={action.kind}
                  options={ACTION_KINDS.map((kind) => ({ value: kind, label: ACTION_LABEL[kind] }))}
                  onChange={(kind) => edit({ type: "action-kind", index, kind: kind as ActionKind })}
                />
                <ActionFields action={action} pickers={pickers} onChange={(next) => edit({ type: "action", index, action: next })} />
              </div>
              <span className="automation-editor__tools">
                <IconButton size="sm" aria-label={`Move action ${index + 1} up`} disabled={index === 0} onClick={() => edit({ type: "move-action", index, step: -1 })}>
                  <ArrowUp size={13} />
                </IconButton>
                <IconButton
                  size="sm"
                  aria-label={`Move action ${index + 1} down`}
                  disabled={index === draft.then.length - 1}
                  onClick={() => edit({ type: "move-action", index, step: 1 })}
                >
                  <ArrowDown size={13} />
                </IconButton>
                <IconButton size="sm" tone="danger" aria-label={`Remove action ${index + 1}`} onClick={() => edit({ type: "remove-action", index })}>
                  <X size={13} />
                </IconButton>
              </span>
              <Problem id={`${baseId}-action-${index}`} message={problemAt(problems, isAction(index))} />
            </li>
          ))}
        </ol>
      </Section>

      <Section title="Limits" describedBy={problemId("limits", isLimits)}>
        <div className="automation-editor__row">
          <FieldLabel>
            Quiet time between firings, minutes
            <Input
              dense
              inputMode="numeric"
              value={draft.minIntervalMinutes}
              onChange={(event) => edit({ type: "min-interval", minutes: event.target.value })}
            />
          </FieldLabel>
          <FieldLabel>
            At most, per hour
            <Input
              dense
              inputMode="numeric"
              value={draft.maxPerHour}
              onChange={(event) => edit({ type: "max-per-hour", count: event.target.value })}
            />
          </FieldLabel>
        </div>
        <p className="automation-editor__note">A limit reached skips the firing and records why. It never turns the automation off.</p>
        {problems.some(isLimits) ? (
          <p id={`${baseId}-limits`} className="automation-editor__problem">
            {problems
              .filter(isLimits)
              .map((problem) => problem.message)
              .join(" ")}
          </p>
        ) : null}
      </Section>

      <footer className="automation-editor__foot">
        {refusal ? (
          <p className="automation-editor__problem" role="alert">
            {refusal}
          </p>
        ) : null}
        {/* aria-disabled, not disabled: the press that saves or reverts would otherwise drop focus to the body. */}
        <Button variant="subtle" size="sm" aria-disabled={!dirty || saving} onClick={onRevert}>
          Revert
        </Button>
        {/* Mounted always, so a reader hears the count when it appears. */}
        <p className="automation-editor__problem" role="status">
          {problems.length === 0
            ? ""
            : problems.length === 1
              ? "One thing to fix before it saves."
              : `${problems.length} things to fix before it saves.`}
        </p>
        <Button ref={saveRef} variant="primary" size="sm" aria-disabled={!dirty || saving} onClick={trySave}>
          {saving ? "Saving" : "Save"}
        </Button>
      </footer>
    </div>
  );
}
