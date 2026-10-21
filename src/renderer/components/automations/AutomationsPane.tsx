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
 * save never undoes a toggle made elsewhere. A queued write marks its
 * row dashed until the editing machine rules.
 */
import { useEffect, useMemo, useState } from "react";
import { Archive, Play, Plus, Zap } from "lucide-react";
import { ulid } from "ulid";
import type {
  Automation,
  AutomationAuthor,
  AutomationId,
  AutomationOp,
  AutomationVersion,
  Firing,
} from "@shared/automation";
import type { Refusal } from "@shared/resource-command";
import type { NodeId } from "@shared/physics/schema";
import { ItemId } from "@shared/work-ids";
import {
  draftOf,
  editDraft,
  finishDraft,
  firingWords,
  historyOrder,
  newDraft,
  triggerWords,
  type AutomationDraft,
} from "../../lib/automation-editor";
import {
  automationsSource,
  useAutomations,
  useFirings,
  type ApplyResult,
} from "../../lib/automations-source";
import { useAutomationTargets } from "../../lib/mention-sources";
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
import { AutomationEditor, useTargetNames } from "./AutomationEditor";
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
      return "That is not available yet.";
    case "queue_full":
      return "Not sent: the queue for the editing machine is full. Try again shortly.";
    default:
      return `Not saved: ${refusal.message}`;
  }
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
              <time
                dateTime={new Date(firing.at).toISOString()}
                className="automation-history__time"
              >
                {timeWords(firing.at)}
              </time>
              <span>{firingWords(firing)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function SidebarRow({
  automation,
  selected,
  dirty,
  pending,
  canvasName,
  onSelect,
}: {
  readonly automation: Automation;
  readonly selected: boolean;
  readonly dirty: boolean;
  /** A write to it is queued, not yet ruled. */
  readonly pending: boolean;
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
      pending={pending}
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
  // A queued write, with the head it was sent against (none for a create); the mark clears once the head moves.
  const [queued, setQueued] = useState<
    ReadonlyMap<AutomationId, Automation | undefined>
  >(new Map());
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
  const open = (next: Editing | undefined): void => {
    setRefusal(undefined);
    setEditing(next);
  };

  const markQueued = (automationId: AutomationId, on: boolean): void =>
    setQueued((now) => {
      const next = new Map(now);
      if (on) next.set(automationId, headOf(automationId));
      else next.delete(automationId);
      return next;
    });

  /** One op; a refusal is kept for the pane to say, a queued op marks its row. */
  const send = async (
    automationId: AutomationId,
    op: AutomationOp,
  ): Promise<ApplyResult> => {
    setBusy(true);
    setRefusal(undefined);
    const result = await automationsSource().apply(
      canvasName,
      nodeId,
      automationId,
      op,
    );
    setBusy(false);
    markQueued(automationId, result.kind === "queued");
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
    });

  /** Sends the draft, over `base` when given (a rebase onto the head), else the version it was loaded from. */
  const save = async (
    base: AutomationVersion | undefined = editing?.base,
  ): Promise<void> => {
    if (!editing) return;
    const finished = finishDraft(editing.draft);
    if (!finished.ok) return;
    const automationId = editing.draft.automationId;
    const { definition } = finished;
    const result = await send(
      automationId,
      base === undefined
        ? {
            kind: "create",
            automationId,
            enabled: editing.draft.enabled,
            definition,
          }
        : { kind: "edit", baseVersion: base, definition },
    );
    if (result.kind === "applied" && result.automation)
      open(editingOf(result.automation));
    else if (result.kind === "queued" && base !== editing.base)
      setEditing({ ...editing, base });
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
    if (result.kind === "applied") open(undefined);
  };

  // The editing machine ruled a queued write once its head moved: created, edited, toggled or archived.
  useEffect(() => {
    setQueued((now) => {
      const settled = [...now].filter(([automationId, before]) => {
        const head = headOf(automationId);
        return before === undefined
          ? head !== undefined
          : head === undefined ||
              head.version !== before.version ||
              head.enabled !== before.enabled;
      });
      if (settled.length === 0) return now;
      const next = new Map(now);
      for (const [automationId] of settled) next.delete(automationId);
      return next;
    });
  }, [automations]);

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

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      label="Automations"
      onClose={() => leave(onClose)}
    >
      <div className="automations-node" data-testid="automations-node">
        <TwoPane
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
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={create}
                    aria-label="New automation"
                  >
                    <Plus size={12} aria-hidden />
                    New
                  </Button>
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
                    pending={queued.has(automation.automationId)}
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
          {editing ? (
            <div className="automations-node__main">
              {editing.base !== undefined ? (
                <div className="automations-node__actions">
                  <Button
                    size="sm"
                    variant="chrome"
                    disabled={busy}
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
                    disabled={busy}
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
                dirty={dirty}
                refusal={
                  refusal
                    ? refusalWords(refusal)
                    : queued.has(editing.draft.automationId)
                      ? "Queued: the editing machine has not ruled on it yet."
                      : undefined
                }
                onSave={() => void save()}
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
                    disabled={busy}
                    onClick={() => open(editingOf(staleHead))}
                  >
                    Take theirs
                  </Button>
                  <Button
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    onClick={() => void save(staleHead.version)}
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
