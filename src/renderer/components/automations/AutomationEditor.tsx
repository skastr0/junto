/**
 * The Automations node's main pane (plan 0.10/07): one automation's
 * definition, edited as a draft. Trigger, conditions, actions and limits,
 * each a section; targets are picked with MentionCombobox from what the
 * automation may reach (`useAutomationTargets`). Nothing leaves the pane
 * until `finishDraft` passes it, and a save carries the version it was
 * edited from.
 */
import { useId, useMemo, useState, type ReactNode, type Ref } from "react";
import { ArrowDown, ArrowUp, Code, Plus, X } from "lucide-react";
import { automationValuesOf, type CodeLanguage } from "@shared/automation";
import { mentionKey, mentionLink, type MentionRef } from "@shared/mention";
import { titleOf } from "@shared/model/title";
import type { ArtifactLabel } from "@shared/artifact-labels";
import type { NodeId } from "@shared/physics/schema";
import { automationTargets } from "@shared/region-reach";
import {
  ACTION_LABEL,
  ARTIFACT_EVENT_WORD,
  ARTIFACT_EVENTS,
  SEAT_BECOMES,
  SIGNAL_RAISES,
  SIGNAL_SHOWS_MAX,
  SIGNAL_WORD,
  SIGNALS,
  TASK_BECOMES,
  TRIGGER_LABEL,
  VALUE_WORDS,
  WATCH_LABEL,
  blankWatch,
  cadenceWords,
  draftProblems,
  editDraft,
  seatStateWord,
  labelNote,
  taskStateWord,
  watchedNode,
  type ActionDraft,
  type ActionKind,
  type AutomationDraft,
  type ConditionDraft,
  type DraftEdit,
  type DraftProblem,
  type EditableTriggerKind,
  type NameOf,
  type SignalFormDraft,
  type SignalRaise,
  type SignalWorkDraft,
  type TargetRef,
  type TriggerDraft,
  type WatchDraft,
  type WatchMode,
  type ArtifactTarget,
} from "../../lib/automation-editor";
import type { MentionCandidate, MentionTrigger } from "../../lib/mention-draft";
import { mentionItemsOf, useCanvasArtifacts } from "../../lib/mention-items";
import { useCanvasTasks } from "../../lib/tasks-source";
import { labelsInNode } from "../artifacts/artifacts-pane-model";
import { useAutomationTargets } from "../../lib/mention-sources";
import { useCanvas } from "../../lib/use-model";
import { useTargetNames } from "../../lib/automation-names";
import { Button, FieldLabel, IconButton, Input, Select, Switch } from "../ui";
import { MentionCombobox } from "../ui/MentionCombobox";
import { ActionText, type ValueChoice } from "./ActionText";

type TargetKind = MentionRef["kind"];

const KIND_NOUN: Readonly<Record<TargetKind, string>> = { seat: "seats", page: "pages", task: "tasks", artifact: "artifacts" };
const AT_KINDS: ReadonlyArray<TargetKind> = ["seat", "page"];

/**
 * The picker's list, named by the kinds it offers under the typed trigger:
 * "Tasks this automation may name", never a kind it does not list.
 */
const listLabelOf = (kinds: ReadonlyArray<TargetKind>, trigger: MentionTrigger): string => {
  const typed = kinds.filter((kind) => AT_KINDS.includes(kind) === (trigger === "@"));
  const nouns = (typed.length > 0 ? typed : kinds).map((kind) => KIND_NOUN[kind]);
  const words = nouns.length <= 1 ? nouns.join("") : `${nouns.slice(0, -1).join(", ")} and ${nouns.at(-1)}`;
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} this automation may name`;
};

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
      listLabel={(trigger) => listLabelOf(kinds, trigger)}
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

/** A task board or an Artifacts node in reach, by its name. */
type NodeChoice = { readonly id: NodeId; readonly title: string };

type Pickers = {
  readonly candidates: ReadonlyArray<MentionCandidate>;
  readonly canvasName: string;
  readonly nameOf: NameOf;
  readonly boards: ReadonlyArray<NodeChoice>;
  readonly artifactNodes: ReadonlyArray<NodeChoice>;
  readonly labelsOf: (node: NodeId) => ReadonlyArray<ArtifactLabel>;
};

/** A word of the sentence between its fields. Read in order with them, so it is not hidden from a screen reader. */
const Word = ({ children }: { readonly children: string }) => <span className="automation-editor__word">{children}</span>;

const ONE = "one";
const nodeValue = (node: NodeId): string => `node:${node}`;

/**
 * Which items a task or artifact watch covers: every one in a node in reach,
 * "in Release", or one item, "named" and picked. Each option carries its own
 * preposition, so either reads as a sentence. A node no longer in reach still
 * shows, named as such, so a loaded watch never reads as a different one.
 */
function ScopeSelect({
  lostLabel,
  nodes,
  covered,
  onChange,
}: {
  /** The covered node once it is out of reach, in the kind's own words. */
  readonly lostLabel: string;
  readonly nodes: ReadonlyArray<NodeChoice>;
  readonly covered: NodeId | undefined;
  readonly onChange: (node: NodeId | undefined) => void;
}) {
  const lost = covered !== undefined && !nodes.some((node) => node.id === covered);
  return (
    <Select
      dense
      aria-label="Watch scope"
      value={covered === undefined ? ONE : nodeValue(covered)}
      options={[
        ...nodes.map((node) => ({ value: nodeValue(node.id), label: `in ${node.title}` })),
        ...(lost ? [{ value: nodeValue(covered), label: `in ${lostLabel}` }] : []),
        { value: ONE, label: "named" },
      ]}
      onChange={(value) => onChange(value === ONE ? undefined : (value.slice("node:".length) as NodeId))}
    />
  );
}

/** Where an artifact watch looks for its label, in words, and the labels found there. */
const artifactLabelNote = (watch: Extract<WatchDraft, { readonly kind: "artifact" }>, pickers: Pickers): string | undefined => {
  const scope = watch.artifact;
  const node = scope === undefined ? undefined : "kind" in scope ? scope.nodeId : scope.node;
  if (node === undefined) {
    const used = [...new Set(pickers.artifactNodes.flatMap((choice) => pickers.labelsOf(choice.id)))].sort();
    return labelNote(watch.label, watch.event, "the Artifacts nodes in reach", used);
  }
  const title = pickers.artifactNodes.find((choice) => choice.id === node)?.title ?? "that node";
  return labelNote(watch.label, watch.event, title, pickers.labelsOf(node));
};

/** An artifact watch with its label as typed; an empty one is no label. */
const withLabel = (watch: Extract<WatchDraft, { readonly kind: "artifact" }>, label: string): WatchDraft => {
  const { label: _old, ...rest } = watch;
  return label === "" ? rest : { ...rest, label };
};

/** One label, typed. Folded and checked when the automation is saved, as the artifact header folds it. */
function LabelField({
  label,
  value,
  onChange,
  describedBy,
}: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onChange: (label: string) => void;
  /** The note under the sentence, while it has one. */
  readonly describedBy: string | undefined;
}) {
  return (
    <Input
      dense
      className="automation-editor__label-field"
      value={value ?? ""}
      spellCheck={false}
      aria-label={label}
      aria-describedby={describedBy}
      placeholder="any label"
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

const typedLabels = (text: string): ReadonlyArray<string> =>
  text
    .split(",")
    .map((label) => label.trim())
    .filter((label) => label !== "");

/**
 * Labels typed as a list, comma between them. The text stays as typed while
 * it says the same labels, so a trailing comma is not taken away mid-word.
 */
function LabelsField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: ReadonlyArray<string> | undefined;
  readonly onChange: (labels: ReadonlyArray<string> | undefined) => void;
}) {
  const [text, setText] = useState(() => (value ?? []).join(", "));
  const same = typedLabels(text).join("\u0000") === (value ?? []).join("\u0000");
  return (
    <FieldLabel>
      {label}
      <Input
        dense
        value={same ? text : (value ?? []).join(", ")}
        spellCheck={false}
        aria-label={label}
        placeholder="publish, weekly"
        onChange={(event) => {
          setText(event.target.value);
          const labels = typedLabels(event.target.value);
          onChange(labels.length === 0 ? undefined : labels);
        }}
      />
    </FieldLabel>
  );
}

const FIRED = "fired";

/**
 * Which artifact an artifact action writes: the one that fired, offered under
 * an artifact trigger, or one picked. A loaded "fired" stays offered under any
 * trigger, so the field never reads as something else; the save says why.
 */
function ArtifactTargetFields({
  label,
  pickerLabel,
  to,
  onChange,
  pickers,
  artifactFired,
}: {
  readonly label: string;
  readonly pickerLabel: string;
  readonly to: ArtifactTarget | undefined;
  readonly onChange: (to: ArtifactTarget | undefined) => void;
  readonly pickers: Pickers;
  readonly artifactFired: boolean;
}) {
  const fired = to !== undefined && "fired" in to;
  return (
    <>
      <Select
        aria-label={label}
        value={fired ? FIRED : ONE}
        options={[
          ...(artifactFired || fired ? [{ value: FIRED, label: "the artifact that fired" }] : []),
          { value: ONE, label: "one artifact" },
        ]}
        onChange={(value) => onChange(value === FIRED ? { fired: true } : undefined)}
      />
      {fired ? null : (
        <TargetPicker
          {...pickers}
          kinds={["artifact"]}
          label={pickerLabel}
          placeholder="#artifact"
          value={to?.kind === "artifact" ? to : undefined}
          onChange={(artifact) => onChange(artifact)}
        />
      )}
    </>
  );
}

/**
 * A watch as a sentence: "a task in Release becomes done", "a task named #42
 * becomes done". A trigger reads "becomes", a condition "is"; the trigger's
 * "When" and the conditions' "Only when" are their section's.
 */
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
  const mode: WatchMode = conditionOnly ? "is" : "becomes";
  // Named apart from the action pickers' fields in a screen reader's list of controls.
  const stateLabel = mode === "becomes" ? "State it becomes" : "State it is in";
  const baseId = useId();
  const note = watch.kind === "artifact" ? artifactLabelNote(watch, pickers) : undefined;
  const noteId = `${baseId}-label-note`;
  /** A new task or artifact watch starts on the first node in reach, the common case, else on one item. */
  const blank = (kind: WatchDraft["kind"]): WatchDraft => {
    const watch = blankWatch(kind);
    const board = pickers.boards[0];
    const artifacts = pickers.artifactNodes[0];
    if (watch.kind === "task" && board !== undefined) return { ...watch, task: { node: board.id } };
    if (watch.kind === "artifact" && artifacts !== undefined) return { ...watch, artifact: { node: artifacts.id } };
    return watch;
  };
  return (
    <>
      <div className="automation-editor__row automation-editor__sentence">
        {conditionOnly ? null : <Word>When</Word>}
        <Select
          dense
          aria-label="What it watches"
          value={watch.kind}
          options={kinds.map((kind) => ({ value: kind, label: WATCH_LABEL[kind] }))}
          onChange={(kind) => {
            if (kind !== watch.kind) onChange(blank(kind as WatchDraft["kind"]));
          }}
        />
        {watch.kind === "seat" ? (
          <>
            <TargetPicker
              {...pickers}
              kinds={["seat"]}
              label="Seat to watch"
              placeholder="@seat"
              value={watch.seat?.kind === "seat" ? watch.seat : undefined}
              onChange={(seat) => onChange({ ...watch, seat })}
            />
            <Select
              dense
              aria-label={stateLabel}
              value={watch.becomes}
              options={SEAT_BECOMES.map((state) => ({ value: state, label: seatStateWord(state, mode) }))}
              onChange={(becomes) => onChange({ ...watch, becomes: becomes as typeof watch.becomes })}
            />
          </>
        ) : null}
        {watch.kind === "task" ? (
          <>
            <ScopeSelect
              lostLabel="a task board out of reach"
              nodes={pickers.boards}
              covered={watchedNode(watch.task)}
              onChange={(node) => onChange({ ...watch, task: node === undefined ? undefined : { node } })}
            />
            {watchedNode(watch.task) === undefined ? (
              <TargetPicker
                {...pickers}
                kinds={["task"]}
                label="Task to watch"
                placeholder="#task"
                value={watch.task !== undefined && "kind" in watch.task && watch.task.kind === "task" ? watch.task : undefined}
                onChange={(task) => onChange({ ...watch, task })}
              />
            ) : null}
            <Word>{mode}</Word>
            <Select
              dense
              aria-label={stateLabel}
              value={watch.becomes}
              options={TASK_BECOMES.map((state) => ({ value: state, label: taskStateWord(state) }))}
              onChange={(becomes) => onChange({ ...watch, becomes: becomes as typeof watch.becomes })}
            />
          </>
        ) : null}
        {watch.kind === "artifact" ? (
          <>
            {watch.event === "labelled" ? null : (
              <>
                <Word>labelled</Word>
                <LabelField
                  label="Only with this label, optional"
                  value={watch.label}
                  describedBy={note === undefined ? undefined : noteId}
                  onChange={(label) => onChange(withLabel(watch, label))}
                />
              </>
            )}
            <ScopeSelect
              lostLabel="an Artifacts node out of reach"
              nodes={pickers.artifactNodes}
              covered={watchedNode(watch.artifact)}
              onChange={(node) => onChange({ ...watch, artifact: node === undefined ? undefined : { node } })}
            />
            {watchedNode(watch.artifact) === undefined ? (
              <TargetPicker
                {...pickers}
                kinds={["artifact"]}
                label="Artifact to watch"
                placeholder="#artifact"
                value={watch.artifact !== undefined && "kind" in watch.artifact && watch.artifact.kind === "artifact" ? watch.artifact : undefined}
                onChange={(artifact) => onChange({ ...watch, artifact })}
              />
            ) : null}
            <Word>is</Word>
            <Select
              dense
              aria-label="Is"
              value={watch.event}
              options={ARTIFACT_EVENTS.map((event) => ({ value: event, label: ARTIFACT_EVENT_WORD[event] }))}
              onChange={(event) => onChange({ ...watch, event: event as typeof watch.event })}
            />
            {watch.event === "labelled" ? (
              <LabelField
                label="The label it gains, or any"
                value={watch.label}
                describedBy={note === undefined ? undefined : noteId}
                onChange={(label) => onChange(withLabel(watch, label))}
              />
            ) : null}
          </>
        ) : null}
        {watch.kind === "signal" ? (
          <>
            <Word>from</Word>
            <TargetPicker
              {...pickers}
              kinds={["seat"]}
              label="From seat, or any"
              placeholder="any seat, or @seat"
              value={watch.from?.kind === "seat" ? watch.from : undefined}
              onChange={(from) => onChange(from === undefined ? { kind: "signal", signal: watch.signal } : { ...watch, from })}
            />
            <Select
              dense
              aria-label="Signal"
              value={watch.signal}
              options={SIGNALS.map((signal) => ({ value: signal, label: SIGNAL_WORD[signal] }))}
              onChange={(signal) => onChange({ ...watch, signal: signal as typeof watch.signal })}
            />
          </>
        ) : null}
      </div>
      {/*
        A live region, mounted while the watch is on artifacts so a reader hears a
        mistyped label as it appears; the field also names it as its description.
      */}
      {watch.kind === "artifact" ? (
        <p id={noteId} role="status" className="automation-editor__note automation-editor__label-note">
          {note ?? ""}
        </p>
      ) : null}
    </>
  );
}

/**
 * A schedule in two fields, and under them the one sentence they mean: the
 * cron is precise, the sentence is what the operator reads back to check it.
 */
function ScheduleFields({
  trigger,
  onChange,
}: {
  readonly trigger: Extract<TriggerDraft, { readonly kind: "schedule" }>;
  readonly onChange: (trigger: TriggerDraft) => void;
}) {
  const cadence = cadenceWords(trigger);
  return (
    <>
      <div className="automation-editor__row">
        <FieldLabel>
          Five-field schedule
          <Input
            dense
            value={trigger.cron}
            spellCheck={false}
            aria-label="Five-field schedule"
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
      {cadence === undefined ? null : <p className="automation-editor__note">Runs {cadence}.</p>}
    </>
  );
}

/** A poll as one plain number, and the sentence it means under it. */
function PollFields({
  trigger,
  onChange,
}: {
  readonly trigger: Extract<TriggerDraft, { readonly kind: "poll" }>;
  readonly onChange: (trigger: TriggerDraft) => void;
}) {
  const cadence = cadenceWords(trigger);
  return (
    <>
      <div className="automation-editor__row">
        <FieldLabel>
          Minutes between runs
          <Input
            dense
            inputMode="numeric"
            value={trigger.everyMinutes}
            aria-label="Minutes between runs"
            onChange={(event) => onChange({ ...trigger, everyMinutes: event.target.value })}
          />
        </FieldLabel>
      </div>
      {cadence === undefined ? null : <p className="automation-editor__note">Runs {cadence}.</p>}
    </>
  );
}

function TriggerFields({ trigger, onChange, pickers }: { readonly trigger: TriggerDraft; readonly onChange: (trigger: TriggerDraft) => void; readonly pickers: Pickers }) {
  switch (trigger.kind) {
    case "schedule":
      return <ScheduleFields trigger={trigger} onChange={onChange} />;
    case "poll":
      return <PollFields trigger={trigger} onChange={onChange} />;
    case "change":
      return <WatchFields watch={trigger.on} pickers={pickers} onChange={(on) => onChange({ ...trigger, on })} />;
    case "webhook":
      return <p className="automation-editor__note">A webhook trigger. Webhooks are not available yet; pick another trigger above to save.</p>;
    default:
      return trigger satisfies never;
  }
}

function ActionFields({
  action,
  onChange,
  pickers,
  values,
  onEditCode,
  artifactFired,
}: {
  readonly action: ActionDraft;
  readonly onChange: (action: ActionDraft) => void;
  readonly pickers: Pickers;
  /** The values this automation's trigger carries, for the Insert value list. */
  readonly values: ReadonlyArray<ValueChoice>;
  /** Whether the trigger is an artifact change, so an artifact action may write the one that fired. */
  readonly artifactFired: boolean;
  /** Opens this step's code; absent where the editor is read alone. */
  readonly onEditCode?: (() => void) | undefined;
}) {
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
          <ActionText
            label="Mail text"
            noun="mail"
            value={action.text}
            placeholder="What the mail says"
            values={values}
            onValue={(text) => onChange({ ...action, text })}
          />
        </>
      );
    case "prompt":
      return (
        <>
          <TargetPicker
            {...pickers}
            kinds={["seat"]}
            label="Prompt to"
            placeholder="@seat"
            value={action.to?.kind === "seat" ? action.to : undefined}
            onChange={(to) => onChange({ ...action, to })}
          />
          <ActionText
            label="Prompt text"
            noun="prompt"
            value={action.text}
            placeholder="What to ask the seat to do"
            values={values}
            onValue={(text) => onChange({ ...action, text })}
          />
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
          <ActionText
            label="Task title"
            noun="task's title"
            multiline={false}
            value={action.title}
            placeholder="Task title"
            values={values}
            onValue={(title) => onChange({ ...action, title })}
          />
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
            label="Task to assign"
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
    case "code":
      return (
        <>
          <Select
            aria-label="Code language"
            value={action.language}
            options={[
              { value: "typescript", label: "TypeScript" },
              { value: "shell", label: "Shell" },
            ]}
            onChange={(language) => onChange({ ...action, language: language as CodeLanguage })}
          />
          <FieldLabel>
            Timeout, in seconds
            <Input
              dense
              inputMode="numeric"
              value={action.timeoutSeconds}
              aria-label="Timeout, in seconds"
              onChange={(event) => onChange({ ...action, timeoutSeconds: event.target.value })}
            />
          </FieldLabel>
          {onEditCode === undefined ? (
            <p className="automation-editor__note">
              {action.source === undefined ? "Write the code before this automation can save." : "Code written."}
            </p>
          ) : (
            <Button size="xs" variant="chrome" onClick={onEditCode}>
              <Code size={12} aria-hidden />
              {action.source === undefined ? "Write code" : "Edit code"}
            </Button>
          )}
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
          <ActionText
            label="Comment text"
            noun="comment"
            value={action.text}
            placeholder="What the comment says"
            values={values}
            onValue={(text) => onChange({ ...action, text })}
          />
        </>
      );
    case "create-artifact":
      return (
        <>
          <Select
            aria-label="Artifacts node"
            placeholder="Pick an Artifacts node"
            value={action.node ?? ""}
            options={pickers.artifactNodes.map((node) => ({ value: node.id, label: node.title }))}
            onChange={(node) => onChange({ ...action, node: node as NodeId })}
          />
          <ActionText
            label="Artifact title"
            noun="artifact's title"
            multiline={false}
            value={action.title}
            placeholder="Artifact title"
            values={values}
            onValue={(title) => onChange({ ...action, title })}
          />
          <ActionText
            label="Artifact body, optional"
            noun="artifact's body"
            value={action.body ?? ""}
            placeholder="What the document says, optional"
            values={values}
            onValue={(body) => {
              const { body: _old, ...rest } = action;
              onChange(body === "" ? rest : { ...rest, body });
            }}
          />
          <LabelsField
            label="Labels, optional"
            value={action.labels}
            onChange={(labels) => {
              const { labels: _old, ...rest } = action;
              onChange(labels === undefined ? rest : { ...rest, labels });
            }}
          />
        </>
      );
    case "append-artifact":
      return (
        <>
          <ArtifactTargetFields
            label="Append to"
            pickerLabel="Artifact to append to"
            to={action.to}
            pickers={pickers}
            artifactFired={artifactFired}
            onChange={(to) => {
              const { to: _old, ...rest } = action;
              onChange(to === undefined ? rest : { ...rest, to });
            }}
          />
          <ActionText
            label="Text to append"
            noun="appended text"
            value={action.text}
            placeholder="What to add at the end"
            values={values}
            onValue={(text) => onChange({ ...action, text })}
          />
        </>
      );
    case "seat-control":
      return (
        <>
          <Select
            aria-label="Start or stop"
            value={action.op}
            options={[
              { value: "start", label: "Start" },
              { value: "stop", label: "Stop" },
            ]}
            onChange={(op) => onChange({ ...action, op: op as typeof action.op })}
          />
          <TargetPicker
            {...pickers}
            kinds={["seat"]}
            label="Seat to start or stop"
            placeholder="@seat"
            value={action.seat?.kind === "seat" ? action.seat : undefined}
            onChange={(seat) => {
              const { seat: _old, ...rest } = action;
              onChange(seat === undefined ? rest : { ...rest, seat });
            }}
          />
        </>
      );
    case "signal":
      return (
        <>
          <Select
            dense
            aria-label="What the signal asks"
            value={action.signal}
            options={SIGNAL_RAISES.map((raise) => ({ value: raise, label: SIGNAL_RAISE_WORD[raise] }))}
            onChange={(raise) => onChange({ ...action, signal: raise as SignalRaise })}
          />
          <ActionText
            label="Signal title"
            noun="title"
            multiline={false}
            value={action.title}
            placeholder="What you see in the feed, one sentence"
            values={values}
            onValue={(title) => onChange({ ...action, title })}
          />
          <ActionText
            label="Signal detail, optional"
            noun="detail"
            value={action.detail ?? ""}
            placeholder="More to read when you open it"
            values={values}
            onValue={(detail) => {
              const { detail: _old, ...rest } = action;
              onChange(detail === "" ? rest : { ...rest, detail });
            }}
          />
          <ShownArtifacts
            pickers={pickers}
            show={action.show ?? []}
            onChange={(show) => {
              const { show: _old, ...rest } = action;
              onChange(show.length === 0 ? rest : { ...rest, show });
            }}
          />
          {action.signal === "work" ? (
            <SignalFormFields
              form={action.form}
              pickers={pickers}
              onChange={(form) => {
                const { form: _old, ...rest } = action;
                onChange(form === undefined ? rest : { ...rest, form });
              }}
            />
          ) : null}
          {action.signal === "work" ? (
            <SignalWorkFields
              work={action.work}
              onChange={(work) => {
                const { work: _old, ...rest } = action;
                onChange(work === undefined ? rest : { ...rest, work });
              }}
            />
          ) : null}
        </>
      );
    case "label-artifact":
      return (
        <>
          <ArtifactTargetFields
            label="Which artifact"
            pickerLabel="Artifact to label"
            to={action.to}
            pickers={pickers}
            artifactFired={artifactFired}
            onChange={(to) => {
              const { to: _old, ...rest } = action;
              onChange(to === undefined ? rest : { ...rest, to });
            }}
          />
          <LabelsField
            label="Labels to add"
            value={action.add}
            onChange={(add) => {
              const { add: _old, ...rest } = action;
              onChange(add === undefined ? rest : { ...rest, add });
            }}
          />
          <LabelsField
            label="Labels to remove"
            value={action.remove}
            onChange={(remove) => {
              const { remove: _old, ...rest } = action;
              onChange(remove === undefined ? rest : { ...rest, remove });
            }}
          />
        </>
      );
    default:
      return action satisfies never;
  }
}

const SIGNAL_RAISE_WORD: Readonly<Record<SignalRaise, string>> = {
  notice: "A notice, to read",
  work: "Work, for you to do",
};

/**
 * The artifacts a signal opens from the feed: one picker each, and one more
 * empty while there is room. Clearing a picker takes its artifact out.
 */
function ShownArtifacts({
  pickers,
  show,
  onChange,
}: {
  readonly pickers: Pickers;
  readonly show: ReadonlyArray<TargetRef>;
  readonly onChange: (show: ReadonlyArray<TargetRef>) => void;
}) {
  const artifacts = show.filter((shown): shown is Extract<TargetRef, { readonly kind: "artifact" }> => shown.kind === "artifact");
  const slots = artifacts.length < SIGNAL_SHOWS_MAX ? [...artifacts, undefined] : artifacts;
  return (
    <>
      {slots.map((shown, index) => (
        <TargetPicker
          // A slot is its place: the list only grows at its end and closes up when one is cleared.
          key={index}
          {...pickers}
          kinds={["artifact"]}
          label={slots.length === 1 ? "Artifact to show, optional" : `Artifact to show, ${index + 1} of ${slots.length}`}
          placeholder="#artifact"
          value={shown}
          onChange={(picked) => {
            const next = [...artifacts];
            if (picked === undefined) next.splice(index, 1);
            else next[index] = picked;
            onChange(next);
          }}
        />
      ))}
    </>
  );
}

const REPLY = "reply";
const FORM_WORD: Readonly<Record<string, string>> = {
  [REPLY]: "By replying",
  artifact: "By writing a document",
  proof: "With proof of what was done",
  secret: "With a secret (made in the CLI; kept while chosen)",
};

/**
 * How the operator answers the signal: a reply, a document written in the
 * signal, or proof. A secret form made elsewhere is kept while it stays
 * chosen: picking another form replaces it, and it cannot be picked here
 * until the vault (N5).
 */
function SignalFormFields({
  form,
  pickers,
  onChange,
}: {
  readonly form: SignalFormDraft | undefined;
  readonly pickers: Pickers;
  readonly onChange: (form: SignalFormDraft | undefined) => void;
}) {
  const chosen = form === undefined || form.kind === "text" ? REPLY : form.kind;
  const offered = [REPLY, "artifact", "proof", ...(chosen === "secret" ? ["secret"] : [])];
  return (
    <>
      <Select
        aria-label="How you answer"
        value={chosen}
        options={offered.map((kind) => ({ value: kind, label: FORM_WORD[kind]! }))}
        onChange={(kind) => {
          if (kind === chosen) return;
          onChange(kind === REPLY ? undefined : kind === "artifact" ? { kind: "artifact" } : kind === "proof" ? { kind: "proof" } : form);
        }}
      />
      {form?.kind === "artifact" ? (
        <>
          <Select
            aria-label="Artifacts node for the writing"
            placeholder="Pick an Artifacts node"
            value={form.node ?? ""}
            options={pickers.artifactNodes.map((node) => ({ value: node.id, label: node.title }))}
            onChange={(node) => onChange({ ...form, node: node as NodeId })}
          />
          <FieldLabel>
            Document title, optional
            <Input
              dense
              value={form.title ?? ""}
              aria-label="Document title, optional"
              placeholder="The signal's title"
              onChange={(event) => {
                const { title: _old, ...rest } = form;
                onChange(event.target.value === "" ? rest : { ...rest, title: event.target.value });
              }}
            />
          </FieldLabel>
          <LabelsField
            label="Document labels"
            value={form.labels}
            onChange={(labels) => {
              const { labels: _old, ...rest } = form;
              onChange(labels === undefined ? rest : { ...rest, labels });
            }}
          />
          <FieldLabel>
            Words at least
            <Input
              dense
              inputMode="numeric"
              value={form.minWords ?? ""}
              aria-label="Words at least"
              placeholder="1"
              onChange={(event) => {
                const { minWords: _old, ...rest } = form;
                onChange(event.target.value === "" ? rest : { ...rest, minWords: event.target.value });
              }}
            />
          </FieldLabel>
        </>
      ) : null}
    </>
  );
}

/** When work falls due after it is raised, in hours, and whether it is urgent from the start. */
function SignalWorkFields({
  work,
  onChange,
}: {
  readonly work: SignalWorkDraft | undefined;
  readonly onChange: (work: SignalWorkDraft | undefined) => void;
}) {
  const next = (change: SignalWorkDraft): void => {
    const merged = { ...work, ...change };
    const kept = {
      ...(merged.dueHours === undefined || merged.dueHours === "" ? {} : { dueHours: merged.dueHours }),
      ...(merged.urgent === true ? { urgent: true } : {}),
    };
    onChange(Object.keys(kept).length === 0 ? undefined : kept);
  };
  return (
    <div className="automation-editor__row">
      <FieldLabel>
        Due after, in hours
        <Input
          dense
          inputMode="decimal"
          value={work?.dueHours ?? ""}
          aria-label="Due after, in hours"
          placeholder="No due time"
          onChange={(event) => next({ dueHours: event.target.value })}
        />
      </FieldLabel>
      <label className="automation-editor__enabled">
        <span>Urgent</span>
        <Switch checked={work?.urgent === true} aria-label="Urgent from the start" onCheckedChange={(urgent) => next({ urgent })} />
      </label>
    </div>
  );
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
  onEditCode,
  onRevert,
  refusal,
  refusalStep,
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
  /** Opens a code step's editor, by its index in then; without it the step says what it needs. */
  readonly onEditCode?: (index: number) => void;
  readonly onRevert: () => void;
  /** Why the last save did not land, in words. */
  readonly refusal?: string;
  /** What to do about it, on its own line under the refusal. */
  readonly refusalStep?: string;
}) {
  const canvas = useCanvas(canvasName);
  // Task boards and Artifacts nodes offer only the items handed to them: without these every #picker is empty.
  const tasks = useCanvasTasks(canvasName);
  const heads = useCanvasArtifacts(canvasName);
  const items = useMemo(() => mentionItemsOf(tasks, heads), [tasks, heads]);
  const candidates = useAutomationTargets(canvasName, draft.nodeId, draft.author, items);
  /** The labels the artifacts of one Artifacts node carry, for a watch's label note. */
  const labelsOf = useMemo(() => {
    const byNode = new Map<NodeId, ReadonlyArray<ArtifactLabel>>();
    return (node: NodeId): ReadonlyArray<ArtifactLabel> => {
      const known = byNode.get(node);
      if (known !== undefined) return known;
      const labels = labelsInNode(heads.filter((head) => head.artifact.nodeId === node && !head.artifact.archived));
      byNode.set(node, labels);
      return labels;
    };
  }, [heads]);
  const nameOf = useTargetNames(candidates, canvasName);
  const { boards, artifactNodes } = useMemo(() => {
    const inReach = automationTargets(canvas, draft.nodeId, draft.author);
    const choices = (kind: "task" | "artifacts"): ReadonlyArray<NodeChoice> =>
      inReach.filter((node) => node.kind === kind).map((node) => ({ id: node.id, title: titleOf(canvas.nodes.get(node.id)!) }));
    return { boards: choices("task"), artifactNodes: choices("artifacts") };
  }, [canvas, draft.nodeId, draft.author]);
  const pickers: Pickers = { candidates, canvasName, nameOf, boards, artifactNodes, labelsOf };
  // Each text an action writes may name what fired it; the trigger decides the set.
  const values = useMemo(
    (): ReadonlyArray<ValueChoice> => automationValuesOf(draft.trigger).map((name) => ({ name, words: VALUE_WORDS[name] })),
    [draft.trigger],
  );
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
                <ActionFields
                  action={action}
                  pickers={pickers}
                  values={values}
                  artifactFired={draft.trigger.kind === "change" && draft.trigger.on.kind === "artifact"}
                  onEditCode={onEditCode === undefined ? undefined : () => onEditCode(index)}
                  onChange={(next) => edit({ type: "action", index, action: next })}
                />
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
            {refusalStep ? (
              <>
                {" "}
                <span className="automation-editor__step">{refusalStep}</span>
              </>
            ) : null}
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
