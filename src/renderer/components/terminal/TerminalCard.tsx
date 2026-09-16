import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { TASKS_ENABLED } from "@shared/features";
import { isHarnessId } from "@shared/managed-terminal-templates";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import {
  agentSeat$,
  presentationForSeat,
  subscribeAgentSeatState,
} from "../../lib/agent-seat-state";
import { isActiveProcessLabel } from "../../lib/activity";
import {
  cardMark,
  seatFactsForNode,
} from "../../lib/seat-projections";
import { useNodeAttentionReasons } from "../../lib/occupancy-feed";
import { terminal$ } from "../../lib/terminal-state";
import { onTerminalEvent } from "../../lib/terminal-events";
import { registerTerminalSessionPoll } from "../../lib/terminal-session-poll";
import {
  sessionChromeUnchanged,
  shouldRefreshSessionFromTerminalEvent,
} from "../../lib/terminal-session-refresh";
import { getJuntoApi } from "../../lib/junto-api";
import { renameTerminalNode } from "../../lib/mutations";
import { ClaimedTaskStrip } from "../nodes/ClaimedTaskStrip";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";

const launchSummary = (
  launch:
    { readonly kind: string; readonly argv?: readonly string[] } | undefined,
): string => {
  if (!launch) return "shell";
  if (launch.kind === "command" && launch.argv?.length)
    return launch.argv.join(" ");
  return launch.kind;
};

/**
 * Terminal node body — identity + status only.
 * Open via double-click or the selection toolbar (TerminalToolbarActions).
 * No Start/Open/Kill buttons on the card.
 * Managed-agent seat state paints attention (amber + !) / working (cyan).
 */
export function TerminalCard({
  node,
  graphBlocked = false,
  renaming = false,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
  readonly renaming?: boolean;
  /** Rename only via RTS pencil (editNodeId) — not card double-click. */
  readonly onRenameDone?: () => void;
}) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  const [session, setSession] = useState<TerminalSessionSummary>();
  const seatEvent = use$(
    agentSeat$.byBindingId[
      native?.bindingId ?? "__junto-terminal-no-binding__"
    ],
  );
  const needsLook = use$(
    agentSeat$.needsLookByBindingId[
      native?.bindingId ?? "__junto-terminal-no-binding__"
    ],
  );
  const attentionReasons = useNodeAttentionReasons(node);

  const applySession = (next: TerminalSessionSummary | undefined) => {
    if (!native) return;
    const prev = terminal$.sessionByBindingId[native.bindingId].peek();
    if (sessionChromeUnchanged(prev, next)) {
      setSession((current) => current ?? next);
      return;
    }
    setSession(next);
    terminal$.sessionByBindingId[native.bindingId].set(next);
    if (next?.nodeId) {
      agentSeat$.bindingIdByNodeId[next.nodeId].set(native.bindingId);
    }
  };

  const refresh = () =>
    native &&
    getJuntoApi()
      ?.terminalGet?.(native.bindingId, native.hostId)
      .then(applySession)
      .catch(() => undefined);

  const running =
    session?.status === "running" || session?.status === "starting";

  useEffect(() => {
    subscribeAgentSeatState();
    void refresh();
    // Routed by binding, so this card is no longer woken by every other
    // terminal's PTY output. shouldRefreshSessionFromTerminalEvent is a
    // separate cut: only session/exit change card chrome.
    const bindingId = native?.bindingId;
    const off = bindingId
      ? onTerminalEvent(
          (raw) => {
            if (!shouldRefreshSessionFromTerminalEvent(raw)) return;
            void refresh();
          },
          { bindingId },
        )
      : () => undefined;
    // Poll only while running — lease-scoped events don't reach cards without
    // an open surface. The poll is a backstop; `off` above is the primary
    // signal. Registration, not a per-card interval: one shared timer batch
    // reads every registered card's host with terminalList, so a 48-terminal
    // canvas costs one IPC round trip per tick instead of 48.
    if (!running || !bindingId) {
      return off;
    }
    const offPoll = registerTerminalSessionPoll(
      bindingId,
      native?.hostId,
      applySession,
    );
    return () => {
      off();
      offPoll();
    };
  }, [native?.bindingId, native?.hostId, running]);

  if (!native)
    return <div className="text-[11px] text-dim">unbound terminal</div>;

  const rawText = node.type === "text" ? node.text : "";
  const firstLine = rawText.split("\n")[0]?.trim() ?? "";
  // Prefer the authorial first line (what rename writes). ether.terminal.label
  // is a spawn-time fallback only — never let it hide a successful rename.
  const label = firstLine || native.label || "terminal";
  const commitRename = (nextFirst: string) => {
    renameTerminalNode(node.id, nextFirst);
  };
  const seatState = seatEvent?.state;
  const presentation = presentationForSeat(seatState, needsLook === true);
  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  const processLive =
    session?.status === "running" || session?.status === "starting";
  // Foreground label only — never launch argv basename (zsh) as "the process".
  // Idle shell OSC titles (user@host:path) are filtered by isActiveProcessLabel.
  const processName =
    session?.processName?.trim() || session?.title?.trim() || undefined;
  const activeProcess =
    session?.status === "starting" ||
    (session?.status === "running" && isActiveProcessLabel(processName));
  const harness =
    typeof node.ether?.terminal?.harness === "string"
      ? node.ether.terminal.harness
      : undefined;
  const managedSeat = harness !== undefined && isHarnessId(harness);
  const activity = cardMark(
    seatFactsForNode({
      nodeId: node.id,
      seatEvent,
      session,
      needsLook: needsLook === true,
      graphBlocked,
      flags: node.ether?.flags,
      attentionReasons,
      managedSeat,
    }),
  );
  // Prefer spawn-failure / attention reason over the raw launch argv line.
  // turn-stalled keeps operator-facing "stalled" wording (not raw reason id).
  const attentionSubtitle =
    seatState === "attention"
      ? seatEvent?.reason === "turn-stalled" ||
        seatEvent?.reason === "prompt-stalled"
        ? "stalled — needs operator look"
        : seatEvent?.reason
      : undefined;
  // Process line only when a non-shell command is running — not shell pid chrome.
  const processSubtitle =
    activeProcess && processName
      ? session?.pid !== undefined
        ? `${processName} — pid ${session.pid}`
        : processName
      : undefined;
  const subtitle =
    (exitReason && exitMessage) ||
    attentionSubtitle ||
    processSubtitle ||
    (presentation === "done" ? "ready — review response" : undefined) ||
    (processLive && !activeProcess ? "seated" : undefined) ||
    launchSummary(native.launch);

  const complete = activity.mode === "pulse" && activity.tone === "green";
  return (
    <div
      className="group relative flex h-full w-full flex-col justify-between overflow-hidden"
      title="Open terminal"
      data-seat-state={presentation ?? seatState}
      data-exit-reason={exitReason}
      data-process-live={processLive ? "true" : undefined}
      data-process-name={processName}
      data-seat-complete={complete ? "true" : undefined}
    >
      <ExecutionCardHeader
        decal={
          <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
            <SquareTerminal size={15} />
          </div>
        }
        title={
          renaming && onRenameDone ? (
            <FirstLineRenameInput
              initial={label}
              ariaLabel="Rename terminal"
              onCommit={commitRename}
              onDone={onRenameDone}
            />
          ) : (
            <div
              className="truncate font-mono text-[14px] font-semibold leading-snug text-ink"
              title={label}
            >
              {label}
            </div>
          )
        }
        subtitle={subtitle}
        activity={
          seatState === "attention" && seatEvent?.reason
            ? { ...activity, label: seatEvent.reason }
            : activity
        }
      />
      <div className="mt-1 truncate text-[10px] tabular-nums text-dim">
        {native.hostId}
      </div>
      {TASKS_ENABLED ? <ClaimedTaskStrip node={node} /> : null}
    </div>
  );
}
