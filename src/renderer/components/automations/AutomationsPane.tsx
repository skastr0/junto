/**
 * The Automations node (plan 0.10/07): a sidebar list of the node's
 * automations, the selected one's definition in the main pane, and its
 * firing history under the definition. Same layout as the Artifacts node
 * (TwoPane). No edges: an automation reaches what is at or below its node.
 *
 * The pane holds one draft at a time. Picking another automation while the
 * draft has unsaved edits asks first. Save sends the whole definition: a new
 * one as `create`, a loaded one as `edit` with the version it was loaded
 * from, refused `stale` with the head when someone saved in between: the
 * draft stays, and the pane offers to send it again over the head or to take
 * the head. A draft with no unsent change follows a new head on its own. On
 * and off is `set-enabled` and lands at once; an edit never carries it, so a
 * save never undoes a toggle made elsewhere. A write is never queued: the
 * editing machine rules it, and any other machine refuses it `not_available`,
 * naming where to make it.
 */
import { useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Archive, Play, Plus, Zap } from "lucide-react";
import { ulid } from "ulid";
import type {
  ActionRuling,
  Automation,
  AutomationAuthor,
  AutomationCodePutResponse,
  AutomationId,
  AutomationOp,
  AutomationVersion,
  Firing,
} from "@shared/automation";
import type { Refusal } from "@shared/resource-command";
import type { NodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import {
  codeRulingWords,
  codeTimeoutMs,
  draftOf,
  draftProblems,
  editDraft,
  finishDraft,
  firingWords,
  heldRulingWords,
  historyOrder,
  answerIsLong,
  signalAnswerOf,
  signalRulingWords,
  newAnsweredDraft,
  newDraft,
  triggerWords,
  withStepId,
  type ActionDraft,
  type AutomationDraft,
  type AutomationNameOf,
  type SignalAnswerShown,
} from "../../lib/automation-editor";
import { openMention } from "../../lib/mention-open";
import {
  automationsSource,
  useAutomations,
  useFirings,
  type ApplyResult,
} from "../../lib/automations-source";
import { useAutomationTargets } from "../../lib/mention-sources";
import { useAutomationsNodeView } from "../../lib/node-view-state";
import {
  Button,
  ConfirmDialog,
  ListRow,
  PaneEmpty,
  PaneHeader,
  ResourceChip,
  StatusDot,
  TwoPane,
} from "../ui";
import { FocusSurface } from "../FocusSurface";
import { claimFocus, isOperatorTyping } from "../../lib/focus-ownership";
import { itemsQuickOpen } from "../../lib/quick-open";
import { useQuickOpen } from "../quick-open/use-quick-open";
import { useSignalsById } from "../../lib/automation-signals";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationCodeEditor, codeTemplate } from "./AutomationCodeEditor";
import { useTargetNames } from "../../lib/automation-names";
import { useThisMachineName } from "../../lib/machines";
import "./automations.css";

type Editing = {
  readonly draft: AutomationDraft;
  /** The version the draft was loaded from; undefined for one not yet saved. */
  readonly base: AutomationVersion | undefined;
  /** The draft as loaded, to tell whether it changed. */
  readonly loaded: AutomationDraft;
};

const editingOf = (automation: Automation): Editing => {
  const draft = draftOf(automation);
  return { draft, base: automation.version, loaded: draft };
};

/** Two drafts that would save the same: `enabled` is its own op, so it does not count. */
const sameDraft = (a: AutomationDraft, b: AutomationDraft): boolean =>
  JSON.stringify({ ...a, enabled: false }) ===
  JSON.stringify({ ...b, enabled: false });

const refusalWords = (refusal: Refusal): string => {
  switch (refusal.reason) {
    case "stale":
    case "rebase_conflict":
      return "Someone saved this automation since you opened it.";
    case "unknown_target":
      return "This automation is gone: it was archived or deleted.";
    case "not_in_reach":
      return "A target is outside what this automation may reach.";
    case "not_available":
      // Off the editing machine main names where to go: "Open "x" on Y to change its automations".
      return refusal.next_step === undefined
        ? `Not available: ${refusal.message}`
        : `${refusal.message.charAt(0).toUpperCase()}${refusal.message.slice(1)}. ${refusal.next_step}.`;
    default:
      return `Not saved: ${refusal.message}`;
  }
};

/** What a save refused asks for next, on its own line: the round trips that are the pane's own say it themselves. */
const refusalStepWords = (refusal: Refusal): string | undefined => {
  if (refusal.next_step === undefined) return undefined;
  if (refusal.reason === "stale" || refusal.reason === "rebase_conflict" || refusal.reason === "not_available") return undefined;
  const step = refusal.next_step.trim();
  return step.endsWith(".") ? step : `${step}.`;
};

const timeWords = (at: number): string =>
  new Date(at).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/**
 * What a signal was answered with, after its step's words (0.11/09 decision
 * 1): the document handed in, as a chip that opens it; proof; a secret only
 * as given; or the reply's words, cut to two lines with the rest a press away.
 */
function SignalAnswer({ answer }: { readonly answer: SignalAnswerShown }) {
  const [whole, setWhole] = useState(false);
  const wordsId = useId();
  switch (answer.kind) {
    case "document":
      return (
        <>
          {" with "}
          <ResourceChip kind="artifact" label={answer.title} onOpen={() => openMention(answer.artifact)} />
        </>
      );
    case "proof":
      return <>{" with proof"}</>;
    case "secret":
      return <>{", secret given"}</>;
    case "words": {
      const long = answerIsLong(answer.text);
      return (
        <>
          {", saying:"}
          <span id={wordsId} className="automation-history__answer" data-whole={!long || whole || undefined}>
            {answer.text}
          </span>
          {long ? (
            <Button size="xs" variant="subtle" aria-expanded={whole} aria-controls={wordsId} onClick={() => setWhole((shown) => !shown)}>
              {whole ? "Show less" : "Show all"}
            </Button>
          ) : null}
        </>
      );
    }
    default:
      return answer satisfies never;
  }
}

function FiringHistory({
  firings,
  focused,
}: {
  readonly firings: ReadonlyArray<Firing>;
  /** The firing a surface opened on (the feed's card): it is marked and brought into view. */
  readonly focused?: string | undefined;
}) {
  const ordered = useMemo(() => historyOrder(firings), [firings]);
  // A firing written on another machine says which one; this machine's own firings do not.
  const here = useThisMachineName();
  // A signal step's ruling names its signal; what became of it is the signal's row, read here.
  const signalIds = useMemo(
    () =>
      ordered.flatMap((firing) =>
        firing.outcome.kind === "fired"
          ? firing.outcome.actions.flatMap((ruling) => (ruling.ruling === "raised" ? [ruling.signalId] : []))
          : [],
      ),
    [ordered],
  );
  const signals = useSignalsById(signalIds);
  useEffect(() => {
    if (focused === undefined) return;
    document.querySelector(`[data-firing="${focused}"]`)?.scrollIntoView({ block: "center" });
  }, [focused, ordered]);
  return (
    <section className="automation-history" aria-label="Firing history">
      <PaneHeader eyebrow="History" />
      {ordered.length === 0 ? (
        <p className="automation-editor__note">It has not fired yet.</p>
      ) : (
        <ol className="automation-history__list">
          {ordered.map((firing) => (
            <li
              key={firing.firingId}
              className="automation-history__row"
              data-outcome={firing.outcome.kind}
              data-firing={firing.firingId}
              data-focused={firing.firingId === focused || undefined}
            >
              <div className="automation-history__line">
                <time
                  dateTime={new Date(firing.at).toISOString()}
                  className="automation-history__time"
                >
                  {timeWords(firing.at)}
                </time>
                <span>{firingWords(firing, here)}</span>
              </div>
              {firing.outcome.kind === "fired"
                ? firing.outcome.actions.map((ruling) => {
                    const signal = ruling.ruling === "raised" ? signals.get(ruling.signalId) : undefined;
                    const words =
                      codeRulingWords(ruling) ??
                      signalRulingWords(ruling, signal, timeWords) ??
                      heldRulingWords(ruling, timeWords);
                    const answer = signalAnswerOf(signal);
                    return words === undefined ? null : (
                      <div key={ruling.index} className="automation-history__step">
                        Step {ruling.index + 1} {words}
                        {answer === undefined ? null : <SignalAnswer answer={answer} />}
                      </div>
                    );
                  })
                : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/** The newest code ruling of the step at `index`, from the firings newest first. */
const lastRulingOf = (index: number, firings: ReadonlyArray<Firing>): ActionRuling | undefined => {
  for (const firing of historyOrder(firings)) {
    if (firing.outcome.kind !== "fired") continue;
    const ruling = firing.outcome.actions.find((action) => action.index === index);
    // Only a code step's own ruling says anything about its code; another kind's at that index does not.
    if (ruling !== undefined && codeRulingWords(ruling) !== undefined) return ruling;
  }
  return undefined;
};

/** The code view's buffer lives in the pane, so leaving the view does not drop what was typed. */
type CodeHeld = {
  readonly index: number;
  readonly text: string;
  readonly loaded: string;
  readonly loading: boolean;
  readonly error?: string;
};

/**
 * One code step, opened from the Then section. The pane reads the stored
 * program (a step never written opens on its language's template) and keeps
 * the buffer; Save hands the text back to the pane, which puts it and saves
 * the automation naming the new ref.
 */
function CodeStepEditor({
  name,
  language,
  timeoutSeconds,
  held,
  result,
  saving,
  unsaved,
  error,
  onCode,
  onSave,
  onRevert,
  onBack,
}: {
  readonly name: string;
  readonly language: Extract<ActionDraft, { readonly kind: "code" }>["language"];
  readonly timeoutSeconds: string;
  readonly held: CodeHeld;
  readonly result: ActionRuling | undefined;
  readonly saving: boolean;
  /** The code has never been saved: the template itself is worth saving. */
  readonly unsaved: boolean;
  readonly error: string | undefined;
  readonly onCode: (text: string) => void;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  readonly onBack: () => void;
}) {
  return (
    <AutomationCodeEditor
      name={name}
      language={language}
      timeoutMs={codeTimeoutMs(timeoutSeconds)}
      code={held.text}
      loading={held.loading}
      saving={saving}
      dirty={held.text !== held.loaded}
      unsaved={unsaved}
      error={error ?? held.error}
      result={result}
      onCode={onCode}
      onSave={onSave}
      onRevert={onRevert}
      onBack={onBack}
    />
  );
}

/** An automation of this list by its name, for an answered trigger's words. */
const automationNameIn =
  (automations: ReadonlyArray<Automation>): AutomationNameOf =>
  (raising) =>
    automations.find((automation) => automation.nodeId === raising.node && automation.automationId === raising.automationId)?.name;

function SidebarRow({
  automation,
  selected,
  dirty,
  canvasName,
  onSelect,
  automationNameOf,
}: {
  readonly automationNameOf: AutomationNameOf;
  readonly automation: Automation;
  readonly selected: boolean;
  readonly dirty: boolean;
  readonly canvasName: string;
  readonly onSelect: () => void;
}) {
  const candidates = useAutomationTargets(
    canvasName,
    automation.nodeId,
    automation.author,
  );
  const nameOf = useTargetNames(candidates, canvasName);
  const trigger = useMemo(() => draftOf(automation).trigger, [automation]);
  return (
    <ListRow
      selected={selected}
      leading={<StatusDot tone={automation.enabled ? "green" : "dim"} />}
      title={`${automation.name}${dirty ? ", edited" : ""}`}
      meta={triggerWords(trigger, nameOf, automationNameOf)}
      onClick={onSelect}
    />
  );
}

export function AutomationsPane({
  canvasName,
  nodeId,
  author,
  initialAutomationId,
  initialFiringId,
  openKey,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  /** The automation to open on, when a surface named one (the feed's card). */
  readonly initialAutomationId?: string;
  /** The firing to mark in that automation's history. */
  readonly initialFiringId?: string;
  /** Which open this is: a new one lands on the firing again. */
  readonly openKey?: number;
  /** Closes the node's surface; with unsaved edits it asks first. */
  readonly onClose: () => void;
  /** Whose reach the pickers offer: the operator here. Main sets the stored author from the actor. */
  readonly author: AutomationAuthor;
}) {
  const automations = useAutomations(canvasName, nodeId);
  const [editing, setEditing] = useState<Editing>();
  const [asking, setAsking] = useState<() => void>();
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<Refusal>();
  const [archiving, setArchiving] = useState(false);
  const firings = useFirings(
    canvasName,
    editing?.base === undefined ? undefined : editing.draft.automationId,
  );

  const dirty =
    editing !== undefined &&
    (editing.base === undefined || !sameDraft(editing.draft, editing.loaded));
  // Leaving unsaved edits asks first; anything else just goes.
  const leave = (then: () => void): void => {
    if (dirty) setAsking(() => then);
    else then();
  };
  // The automation open outlives the pane and a quit, per node; a new one not yet saved is not kept.
  const kept = useAutomationsNodeView(canvasName, nodeId);
  const [codeStep, setCodeStep] = useState<number | undefined>(undefined);
  const [codeHeld, setCodeHeld] = useState<CodeHeld | undefined>(undefined);
  /** What kept the code from saving, in words: it shows in the code view, where the definition's problems cannot. */
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  /** What the Discard dialog confirms: leaving the code view, or reverting to the saved program. */
  const [codeAsking, setCodeAsking] = useState<(() => void) | undefined>(undefined);
  const open = (next: Editing | undefined): void => {
    setRefusal(undefined);
    setCodeError(undefined);
    // A save of the same automation keeps the code view; another one closes it.
    setCodeStep((prior) => (prior !== undefined && editing?.draft.automationId === next?.draft.automationId ? prior : undefined));
    setEditing(next);
    if (next === undefined || next.base !== undefined) kept.setOpen(next?.draft.automationId ?? null);
  };
  /** Once the list arrives, the automation the node had open opens again. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || automations.length === 0) return;
    restored.current = true;
    const head = automations.find((automation) => automation.automationId === kept.open);
    if (editing === undefined && head !== undefined) open(editingOf(head));
  }, [automations]);

  /**
   * A surface opened this pane on one firing (the feed's card): open that
   * automation once, and mark the firing when its history arrives. A new open
   * key lands on it again even for the same automation.
   */
  const [focusedFiring, setFocusedFiring] = useState<string | undefined>(initialFiringId);
  const landedOn = useRef("");
  useEffect(() => {
    if (initialAutomationId === undefined || automations.length === 0) return;
    const key = `${openKey ?? 0}:${initialAutomationId}:${initialFiringId ?? ""}`;
    if (landedOn.current === key) return;
    landedOn.current = key;
    setFocusedFiring(initialFiringId);
    const head = automations.find((automation) => automation.automationId === initialAutomationId);
    if (head !== undefined) leave(() => open(editingOf(head)));
  }, [initialAutomationId, initialFiringId, openKey, automations]);

  /** One op; a refusal is kept for the pane to say. */
  const send = async (
    automationId: AutomationId,
    op: AutomationOp,
  ): Promise<ApplyResult> => {
    setBusy(true);
    setRefusal(undefined);
    // A write that fails to reach its ruler reads as a refusal, never a pane stuck busy.
    const result = await automationsSource()
      .apply(canvasName, nodeId, automationId, op)
      .catch(
        (cause: unknown): ApplyResult => ({
          kind: "refused",
          refusal: {
            reason: "not_available",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    setBusy(false);
    if (result.kind === "refused") setRefusal(result.refusal);
    return result;
  };

  const headOf = (
    automationId: AutomationId | undefined,
  ): Automation | undefined =>
    automations.find((automation) => automation.automationId === automationId);

  const create = (): void =>
    leave(() => {
      const draft = newDraft(
        ItemId.make(ulid()) as AutomationId,
        nodeId,
        author,
      );
      open({ draft, base: undefined, loaded: draft });
      // The name is what you type next, and the empty state's New unmounts.
      setRefocus("name");
    });

  /** Sends the draft, over `base` when given (a rebase onto the head), else the version it was loaded from. */
  const save = async (
    base: AutomationVersion | undefined = editing?.base,
    draft: AutomationDraft | undefined = editing?.draft,
  ): Promise<boolean> => {
    if (!editing || draft === undefined) return false;
    const finished = finishDraft(draft);
    if (!finished.ok) return false;
    const automationId = draft.automationId;
    const { definition } = finished;
    const result = await send(
      automationId,
      base === undefined
        ? {
            kind: "create",
            automationId,
            enabled: draft.enabled,
            definition,
          }
        : { kind: "edit", baseVersion: base, definition },
    );
    if (result.kind === "applied" && result.automation)
      open(editingOf(result.automation));
    return result.kind === "applied";
  };

  /**
   * A signal step's "When answered…": the step gets its id, the automation
   * is saved with it when anything is unsaved, and a new automation opens
   * whose trigger names the step. It is made on this node: an answered
   * watch names an automation on its own node.
   */
  const whenAnswered = async (index: number): Promise<void> => {
    if (!editing) return;
    const named = withStepId(editing.draft, index);
    const step = editing.draft.then[index];
    if (named === undefined || step?.kind !== "signal") return;
    if ((named.draft !== editing.draft || dirty || editing.base === undefined) && !(await save(editing.base, named.draft))) return;
    const draft = newAnsweredDraft(
      ItemId.make(ulid()) as AutomationId,
      nodeId,
      author,
      { node: nodeId, automationId: editing.draft.automationId },
      named.id,
      step.title,
    );
    open({ draft, base: undefined, loaded: draft });
    // The name is what you type next: it says which signal it answers, for the operator to keep or change.
    setRefocus("name");
  };

  /** Another automation of this node, from a link between an answered trigger and its signal step. */
  const openAutomation = (automationId: AutomationId): void => {
    const head = headOf(automationId);
    if (head !== undefined && automationId !== editing?.draft.automationId) leave(() => open(editingOf(head)));
  };

  const codeAction = codeStep === undefined ? undefined : editing?.draft.then[codeStep];
  const codeLanguage = codeAction !== undefined && codeAction.kind === "code" ? codeAction.language : undefined;
  const codeSource = codeAction !== undefined && codeAction.kind === "code" ? codeAction.source : undefined;
  useEffect(() => {
    if (codeStep === undefined || codeLanguage === undefined) {
      setCodeHeld(undefined);
      return;
    }
    let live = true;
    const index = codeStep;
    const source = codeSource;
    const read =
      source === undefined
        ? Promise.resolve({ kind: "read" as const, text: codeTemplate(codeLanguage) })
        : automationsSource().codeRead(canvasName, source);
    void read.then((result) => {
      if (!live) return;
      setCodeHeld(
        result.kind === "refused"
          ? { index, text: "", loaded: "", loading: false, error: result.refusal.message }
          : { index, text: result.text, loaded: result.text, loading: false },
      );
    });
    return () => {
      live = false;
    };
  }, [canvasName, codeStep, codeLanguage, codeSource]);

  /**
   * The keyboard follows the view: the code takes it as the code view opens,
   * and leaving hands it back to the pane's Save, never the body.
   */
  const codeSurface = useRef<HTMLElement>(null);
  useEffect(() => {
    if (codeStep === undefined || codeHeld === undefined || codeHeld.loading) return;
    const surface = codeSurface.current;
    if (surface === null) return;
    const claim = (): boolean => {
      const editor = surface.querySelector<HTMLElement>(".cm-content");
      if (editor === null) return false;
      // focus-law: an open claim, and never over a field the operator is typing in: a slow read must not take that.
      const active = document.activeElement;
      if (!isOperatorTyping(active) || surface.contains(active)) claimFocus(editor, "open");
      return true;
    };
    if (claim()) return;
    // The editor's engine may still be loading: the code takes the keyboard once it draws.
    const drawn = new MutationObserver(() => {
      if (claim()) drawn.disconnect();
    });
    drawn.observe(surface, { childList: true, subtree: true });
    return () => drawn.disconnect();
  }, [codeStep, codeHeld?.loading]);

  /**
   * Leaving the code view drops what was typed unless it is saved, as leaving
   * a draft does. Back runs the default continuation; closing the whole pane
   * passes its own, so Escape and the backdrop ask where Back asks.
   */
  const leaveCode = (then?: () => void): void => {
    const after =
      then ??
      ((): void => {
        setCodeStep(undefined);
        settleFocus();
      });
    if (codeHeld !== undefined && codeHeld.text !== codeHeld.loaded) setCodeAsking(() => after);
    else after();
  };

  /**
   * A code step's Save: the text is put first, so the definition always names
   * a program that exists, and the automation is saved with the new ref. A
   * problem anywhere else in the automation stops it here, in words, because
   * the code view hides the fields that carry it.
   */
  const saveCode = async (text: string, index: number): Promise<void> => {
    if (!editing) return;
    const action = editing.draft.then[index];
    if (action === undefined || action.kind !== "code") return;
    setCodeError(undefined);
    // This step's own problem is the code it has not got yet; everything else belongs to the fields behind Back.
    const elsewhere = draftProblems(editing.draft).filter((problem) => !(problem.at === "action" && problem.index === index));
    if (elsewhere.length > 0) {
      setCodeError(
        elsewhere.length === 1
          ? "The automation has one thing to fix before it saves. Back shows it."
          : `The automation has ${elsewhere.length} things to fix before it saves. Back shows them.`,
      );
      return;
    }
    setBusy(true);
    setRefusal(undefined);
    const put = await automationsSource()
      .codePut(canvasName, text)
      .catch(
        (cause: unknown): AutomationCodePutResponse => ({
          kind: "refused",
          refusal: {
            reason: "not_available",
            message: cause instanceof Error ? cause.message : String(cause),
          },
        }),
      );
    if (put.kind === "refused") {
      setBusy(false);
      setRefusal(put.refusal);
      return;
    }
    setBusy(false);
    const draft = editDraft(editing.draft, { type: "action", index, action: { ...action, source: put.ref } });
    setEditing({ ...editing, draft });
    // The buffer is what the head holds once the save lands: Back then has nothing to ask about.
    if (await save(editing.base, draft)) setCodeHeld((prior) => (prior === undefined ? prior : { ...prior, loaded: text }));
  };

  // A loaded automation turns on and off at once, keeping any edits in the draft.
  const setEnabled = async (enabled: boolean): Promise<void> => {
    if (!editing) return;
    if (editing.base === undefined) {
      setEditing({
        ...editing,
        draft: editDraft(editing.draft, { type: "enabled", enabled }),
      });
      return;
    }
    const result = await send(editing.draft.automationId, {
      kind: "set-enabled",
      enabled,
    });
    const saved = result.kind === "applied" ? result.automation : undefined;
    if (saved) {
      const flip = (draft: AutomationDraft): AutomationDraft =>
        editDraft(draft, { type: "enabled", enabled: saved.enabled });
      // The head moved by the toggle alone, so the draft's edits stay on top of it.
      setEditing({
        draft: flip(editing.draft),
        loaded: flip(editing.loaded),
        base: saved.version,
      });
    }
  };

  // A stale save lost to the head: keep the draft and send it over the head, or take the head.
  const staleHead =
    refusal?.reason === "stale" || refusal?.reason === "rebase_conflict"
      ? headOf(editing?.draft.automationId)
      : undefined;

  const archive = async (): Promise<void> => {
    if (!editing) return;
    setArchiving(false);
    const result = await send(editing.draft.automationId, { kind: "archive" });
    if (result.kind === "applied") {
      open(undefined);
      settleFocus();
    }
  };

  // A press whose control then leaves the pane (Archive, the stale choices)
  // would drop focus to the body: once it renders, focus goes to Save, or to
  // New with no automation open. A new automation focuses its name. Only
  // after such a press, never on a live update.
  const newButton = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const [refocus, setRefocus] = useState<"lost" | "name">();
  const settleFocus = (): void => setRefocus("lost");
  useEffect(() => {
    if (refocus === undefined) return;
    setRefocus(undefined);
    if (refocus === "name") {
      // The name is prefilled, "New automation" or the signal it answers: selected, so typing replaces it.
      claimFocus(nameField.current, "gesture", { select: true });
      return;
    }
    const lost =
      document.activeElement === null ||
      document.activeElement === document.body;
    if (lost) claimFocus((editing ? saveButton : newButton).current, "gesture");
  }, [refocus]);


  // A draft with no unsent change follows its head: an edit, a toggle or an archive made elsewhere.
  useEffect(() => {
    if (
      editing === undefined ||
      editing.base === undefined ||
      dirty ||
      refusal !== undefined
    )
      return;
    const head = headOf(editing.draft.automationId);
    if (head === undefined) open(undefined);
    else if (
      head.version !== editing.base ||
      head.enabled !== editing.loaded.enabled
    )
      open(editingOf(head));
  }, [automations]);

  const selectedId = editing?.draft.automationId;
  const listed = automations.some(
    (automation) => automation.automationId === selectedId,
  );

  /** A pick in the palette opens that automation; unsaved edits still ask first. */
  const quickOpen = useQuickOpen({
    nodeId,
    enabled: automations.length > 0,
    source: useMemo(
      () =>
        itemsQuickOpen({
          kind: "automation",
          items: automations,
          itemOf: (automation) => ({
            row: { id: automation.automationId, title: automation.name },
            match: { identity: [automation.name] },
          }),
        }),
      [automations],
    ),
    onOpen: (item) => {
      const picked = automations.find((automation) => automation.automationId === item.id);
      if (picked !== undefined && picked.automationId !== selectedId) leave(() => open(editingOf(picked)));
    },
  });

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      label="Automations"
      onClose={() => leave(() => leaveCode(onClose))}
    >
      {quickOpen.palette}
      <div className="automations-node" data-testid="automations-node">
        <TwoPane keptBy={{ canvas: canvasName, node: nodeId }}
          sidebarLabel="Automations"
          mainLabel={
            editing
              ? editing.draft.name || "Automation"
              : "No automation selected"
          }
          sidebar={
            <>
              <PaneHeader
                eyebrow="Automations"
                actions={
                  <>
                    {quickOpen.trigger}
                    <Button
                      ref={newButton}
                      size="xs"
                      variant="subtle"
                      onClick={create}
                      aria-label="New automation"
                    >
                      <Plus size={12} aria-hidden />
                      New
                    </Button>
                  </>
                }
              />
              <div className="automations-node__list">
                {editing && !listed ? (
                  <ListRow
                    selected
                    title={`${editing.draft.name}, not saved`}
                    leading={<StatusDot tone="dim" />}
                  />
                ) : null}
                {automations.map((automation) => (
                  <SidebarRow
                    key={automation.automationId}
                    automation={automation}
                    canvasName={canvasName}
                    automationNameOf={automationNameIn(automations)}
                    selected={automation.automationId === selectedId}
                    dirty={automation.automationId === selectedId && dirty}
                    onSelect={() => {
                      if (automation.automationId !== selectedId)
                        leave(() => open(editingOf(automation)));
                    }}
                  />
                ))}
              </div>
            </>
          }
        >
          {editing && codeStep !== undefined && editing.draft.then[codeStep]?.kind === "code" ? (
            <div ref={codeSurface as RefObject<HTMLDivElement>} className="automations-node__main automations-node__main--code">
              <CodeStepEditor
                name={editing.draft.name}
                language={(editing.draft.then[codeStep] as Extract<ActionDraft, { readonly kind: "code" }>).language}
                timeoutSeconds={(editing.draft.then[codeStep] as Extract<ActionDraft, { readonly kind: "code" }>).timeoutSeconds}
                held={codeHeld ?? { index: codeStep, text: "", loaded: "", loading: true }}
                result={lastRulingOf(codeStep, firings)}
                saving={busy}
                unsaved={(editing.draft.then[codeStep] as Extract<ActionDraft, { readonly kind: "code" }>).source === undefined}
                error={codeError ?? (refusal ? refusalWords(refusal) : undefined)}
                onCode={(text) => {
                  setCodeError(undefined);
                  setCodeHeld((prior) => (prior === undefined ? prior : { ...prior, text }));
                }}
                onSave={() => void saveCode(codeHeld?.text ?? "", codeStep)}
                onRevert={() => {
                  const revert = (): void => setCodeHeld((prior) => (prior === undefined ? prior : { ...prior, text: prior.loaded }));
                  if (codeHeld !== undefined && codeHeld.text !== codeHeld.loaded) setCodeAsking(() => revert);
                  else revert();
                }}
                onBack={() => leaveCode()}
              />
            </div>
          ) : editing ? (
            <div className="automations-node__main">
              {editing.base !== undefined ? (
                <div className="automations-node__actions">
                  {/* aria-disabled while busy: a press that disables its own button would drop focus to the body. */}
                  <Button
                    size="sm"
                    variant="chrome"
                    aria-disabled={busy}
                    onClick={() =>
                      void send(editing.draft.automationId, { kind: "run" })
                    }
                  >
                    <Play size={12} aria-hidden />
                    Run now
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    aria-disabled={busy}
                    onClick={() => setArchiving(true)}
                  >
                    <Archive size={12} aria-hidden />
                    Archive
                  </Button>
                </div>
              ) : null}
              <AutomationEditor
                draft={editing.draft}
                onDraft={(draft) => setEditing({ ...editing, draft })}
                onEnabled={(enabled) => void setEnabled(enabled)}
                canvasName={canvasName}
                saving={busy}
                saveRef={saveButton}
                nameRef={nameField}
                dirty={dirty}
                refusal={refusal ? refusalWords(refusal) : undefined}
                refusalStep={refusal ? refusalStepWords(refusal) : undefined}
                onSave={() => void save()}
                onEditCode={(index) => setCodeStep(index)}
                automations={automations}
                onOpenAutomation={openAutomation}
                onWhenAnswered={(index) => void whenAnswered(index)}
                onRevert={() =>
                  setEditing({ ...editing, draft: editing.loaded })
                }
              />
              {staleHead ? (
                <div
                  className="automations-node__actions"
                  role="group"
                  aria-label="Saved elsewhere"
                >
                  <Button
                    size="sm"
                    variant="chrome"
                    aria-disabled={busy}
                    onClick={() => {
                      open(editingOf(staleHead));
                      settleFocus();
                    }}
                  >
                    Take theirs
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    aria-disabled={busy}
                    onClick={() => void save(staleHead.version).then(settleFocus)}
                  >
                    Send mine over theirs
                  </Button>
                </div>
              ) : null}
              {editing.base !== undefined ? (
                <FiringHistory firings={firings} focused={focusedFiring} />
              ) : null}
            </div>
          ) : (
            <PaneEmpty
              glyph={<Zap size={20} />}
              title={
                automations.length === 0
                  ? "No automations yet"
                  : "Pick an automation"
              }
              hint="An automation acts on the seats, tasks and artifacts at or below this node, on a schedule or when something changes."
              action={
                automations.length === 0 ? (
                  <Button size="sm" variant="primary" onClick={create}>
                    New automation
                  </Button>
                ) : undefined
              }
            />
          )}
        </TwoPane>
        {archiving && editing ? (
          <ConfirmDialog
            title={`Archive ${editing.draft.name}?`}
            confirmLabel="Archive"
            tone="danger"
            busy={busy}
            onCancel={() => setArchiving(false)}
            onConfirm={() => void archive()}
          >
            <p>It stops firing and leaves this list.</p>
          </ConfirmDialog>
        ) : null}
        {codeAsking ? (
          <ConfirmDialog
            title="Discard this code?"
            confirmLabel="Discard"
            tone="danger"
            onCancel={() => setCodeAsking(undefined)}
            onConfirm={() => {
              const then = codeAsking;
              setCodeAsking(undefined);
              then();
            }}
          >
            <p>The code you wrote is not saved.</p>
          </ConfirmDialog>
        ) : null}
        {asking ? (
          <ConfirmDialog
            title="Discard your edits?"
            confirmLabel="Discard"
            tone="danger"
            onCancel={() => setAsking(undefined)}
            onConfirm={() => {
              const then = asking;
              setAsking(undefined);
              then();
            }}
          >
            <p>This automation has edits that are not saved.</p>
          </ConfirmDialog>
        ) : null}
      </div>
    </FocusSurface>
  );
}
