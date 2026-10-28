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
import { useEffect, useMemo, useRef, useState } from "react";
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
  editDraft,
  finishDraft,
  firingWords,
  historyOrder,
  newDraft,
  triggerWords,
  type ActionDraft,
  type AutomationDraft,
} from "../../lib/automation-editor";
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
  StatusDot,
  TwoPane,
} from "../ui";
import { FocusSurface } from "../FocusSurface";
import { claimFocus } from "../../lib/focus-ownership";
import { itemsQuickOpen } from "../../lib/quick-open";
import { useQuickOpen } from "../quick-open/use-quick-open";
import { AutomationEditor } from "./AutomationEditor";
import { AutomationCodeEditor, CODE_TEMPLATE } from "./AutomationCodeEditor";
import { useTargetNames } from "../../lib/automation-names";
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

function FiringHistory({
  firings,
}: {
  readonly firings: ReadonlyArray<Firing>;
}) {
  const ordered = useMemo(() => historyOrder(firings), [firings]);
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
            >
              <div className="automation-history__line">
                <time
                  dateTime={new Date(firing.at).toISOString()}
                  className="automation-history__time"
                >
                  {timeWords(firing.at)}
                </time>
                <span>{firingWords(firing)}</span>
              </div>
              {firing.outcome.kind === "fired"
                ? firing.outcome.actions.map((ruling) => {
                    const words = codeRulingWords(ruling);
                    return words === undefined ? null : (
                      <p key={ruling.index} className="automation-history__step">
                        Step {ruling.index + 1} {words}
                      </p>
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

/** The newest ruling of the step at `index`, from the firings newest first. */
const lastRulingOf = (index: number, firings: ReadonlyArray<Firing>): ActionRuling | undefined => {
  for (const firing of historyOrder(firings)) {
    if (firing.outcome.kind !== "fired") continue;
    const ruling = firing.outcome.actions.find((action) => action.index === index);
    if (ruling !== undefined) return ruling;
  }
  return undefined;
};

/**
 * One code step, opened from the Then section. It reads the stored program
 * (a step never written opens on the template), and Save hands the text back
 * to the pane, which puts it and saves the automation naming the new ref.
 */
function CodeStepEditor({
  canvasName,
  name,
  action,
  index,
  result,
  saving,
  error,
  onSave,
  onBack,
}: {
  readonly canvasName: string;
  readonly name: string;
  readonly action: Extract<ActionDraft, { readonly kind: "code" }>;
  readonly index: number;
  readonly result: ActionRuling | undefined;
  readonly saving: boolean;
  readonly error: string | undefined;
  readonly onSave: (text: string, index: number) => void;
  readonly onBack: () => void;
}) {
  const [held, setHeld] = useState<{ readonly text: string; readonly loaded: string; readonly loading: boolean; readonly error?: string }>({
    text: "",
    loaded: "",
    loading: true,
  });
  useEffect(() => {
    let live = true;
    const source = action.source;
    const read =
      source === undefined
        ? Promise.resolve({ kind: "read" as const, text: CODE_TEMPLATE })
        : automationsSource().codeRead(canvasName, source);
    void read.then((result) => {
      if (!live) return;
      setHeld(
        result.kind === "refused"
          ? { text: "", loaded: "", loading: false, error: result.refusal.message }
          : { text: result.text, loaded: result.text, loading: false },
      );
    });
    return () => {
      live = false;
    };
  }, [canvasName, action.source]);
  return (
    <AutomationCodeEditor
      name={name}
      language={action.language}
      timeoutMs={codeTimeoutMs(action.timeoutSeconds)}
      code={held.text}
      loading={held.loading}
      saving={saving}
      dirty={held.text !== held.loaded}
      error={error ?? held.error}
      result={result}
      onCode={(text) => setHeld((prior) => ({ ...prior, text }))}
      onSave={() => onSave(held.text, index)}
      onRevert={() => setHeld((prior) => ({ ...prior, text: prior.loaded }))}
      onBack={onBack}
    />
  );
}

function SidebarRow({
  automation,
  selected,
  dirty,
  canvasName,
  onSelect,
}: {
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
      meta={triggerWords(trigger, nameOf)}
      onClick={onSelect}
    />
  );
}

export function AutomationsPane({
  canvasName,
  nodeId,
  author,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
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
  const open = (next: Editing | undefined): void => {
    setRefusal(undefined);
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
  ): Promise<void> => {
    if (!editing || draft === undefined) return;
    const finished = finishDraft(draft);
    if (!finished.ok) return;
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
  };

  /**
   * A code step's Save: the text is put first, so the definition always names
   * a program that exists, and the automation is saved with the new ref.
   */
  const saveCode = async (text: string, index: number): Promise<void> => {
    if (!editing) return;
    const action = editing.draft.then[index];
    if (action === undefined || action.kind !== "code") return;
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
    await save(editing.base, draft);
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
      claimFocus(nameField.current, "gesture");
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
      onClose={() => leave(onClose)}
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
            <div className="automations-node__main">
              <CodeStepEditor
                canvasName={canvasName}
                name={editing.draft.name}
                index={codeStep}
                action={editing.draft.then[codeStep] as Extract<ActionDraft, { readonly kind: "code" }>}
                result={lastRulingOf(codeStep, firings)}
                saving={busy}
                error={refusal ? refusalWords(refusal) : undefined}
                onSave={(text, index) => void saveCode(text, index)}
                onBack={() => setCodeStep(undefined)}
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
                <FiringHistory firings={firings} />
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
