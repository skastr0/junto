import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import {
  agentSeat$,
  presentationForSeat,
  subscribeAgentSeatState,
} from "../../lib/agent-seat-state";
import { terminalActivity } from "../../lib/activity";
import { terminal$ } from "../../lib/terminal-state";
import { onTerminalEvent } from "../../lib/terminal-events";
import { getVellumApi } from "../../lib/vellum-api";
import { editText } from "../../lib/mutations";
import { INK } from "../../lib/theme";
import { ClaimedTaskStrip } from "../nodes/ClaimedTaskStrip";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";

/** First-line rename — Enter/blur commits, Escape discards. */
function RenameInput({
  initial,
  onCommit,
  onDone,
}: {
  readonly initial: string;
  readonly onCommit: (firstLine: string) => void;
  readonly onDone: () => void;
}) {
  const [value, setValue] = useState(initial);
  const firedRef = useRef(false);

  const finish = (commit: boolean) => {
    if (firedRef.current) return;
    firedRef.current = true;
    const next = value.trim();
    if (commit && next && next !== initial) onCommit(next);
    onDone();
  };

  return (
    <input
      ref={(el) => {
        el?.focus();
        el?.select();
      }}
      aria-label="Rename terminal"
      className="nodrag nopan nowheel w-full truncate bg-transparent text-left font-mono text-[14px] font-semibold leading-snug outline-none"
      style={{ color: INK }}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          finish(false);
        }
      }}
    />
  );
}

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
 * No Start/Open/Kill buttons on the card (herdr pattern).
 * Managed-agent seat state paints attention (amber + !) / working (cyan).
 */
export function TerminalCard({
  node,
  graphBlocked = false,
  renaming = false,
  onRequestRename,
  onRenameDone,
}: {
  readonly node: CanvasNode;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
  readonly renaming?: boolean;
  readonly onRequestRename?: () => void;
  readonly onRenameDone?: () => void;
}) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  const [session, setSession] = useState<TerminalSessionSummary>();
  const seatEvent = use$(
    agentSeat$.byBindingId[
      native?.bindingId ?? "__vellum-terminal-no-binding__"
    ],
  );
  const needsLook = use$(
    agentSeat$.needsLookByBindingId[
      native?.bindingId ?? "__vellum-terminal-no-binding__"
    ],
  );

  const refresh = () =>
    native &&
    getVellumApi()
      ?.terminalGet?.(native.bindingId, native.hostId)
      .then((next) => {
        setSession(next);
        terminal$.sessionByBindingId[native.bindingId].set(next);
        if (next?.nodeId) {
          agentSeat$.bindingIdByNodeId[next.nodeId].set(native.bindingId);
        }
      })
      .catch(() => undefined);

  const running =
    session?.status === "running" || session?.status === "starting";

  useEffect(() => {
    subscribeAgentSeatState();
    void refresh();
    const off = onTerminalEvent((raw) => {
      if ((raw as { bindingId?: string }).bindingId === native?.bindingId)
        void refresh();
    });
    // Poll only while running — lease-scoped events don't reach cards without
    // an open surface.
    if (!running) {
      return off;
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      off();
      window.clearInterval(timer);
    };
  }, [native?.bindingId, native?.hostId, running]);

  if (!native)
    return <div className="text-[11px] text-dim">unbound terminal</div>;

  const rawText = node.type === "text" ? node.text : "";
  const firstLine = rawText.split("\n")[0] ?? "";
  const label = native.label ?? (firstLine || "terminal");
  const commitRename = (nextFirst: string) => {
    const rest = rawText.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${nextFirst}\n${rest}` : nextFirst);
  };
  const seatState = seatEvent?.state;
  const presentation = presentationForSeat(seatState, needsLook === true);
  const exitReason = session?.exitReason;
  const exitMessage = session?.exitMessage;
  const activity = terminalActivity({
    seatState,
    needsLook: needsLook === true,
    seatReason: seatEvent?.reason,
    running: session?.status === "running",
    starting: session?.status === "starting",
    graphBlocked,
    exitReason,
    exitMessage,
  });
  // Prefer spawn-failure / attention reason over the raw launch argv line.
  // turn-stalled keeps operator-facing "stalled" wording (not raw reason id).
  const attentionSubtitle =
    seatState === "attention"
      ? seatEvent?.reason === "turn-stalled" ||
        seatEvent?.reason === "prompt-stalled"
        ? "stalled — needs operator look"
        : seatEvent?.reason
      : undefined;
  const subtitle =
    (exitReason && exitMessage) ||
    attentionSubtitle ||
    (presentation === "done" ? "ready — review response" : undefined) ||
    launchSummary(native.launch);

  const complete = activity.mode === "pulse" && activity.tone === "green";
  return (
    <div
      className="group relative flex h-full w-full flex-col justify-between overflow-hidden"
      title="double-click to open"
      data-seat-state={presentation ?? seatState}
      data-exit-reason={exitReason}
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
            <RenameInput
              initial={firstLine || label}
              onCommit={commitRename}
              onDone={onRenameDone}
            />
          ) : (
            <button
              type="button"
              className="nodrag nopan w-full truncate text-left font-mono text-[14px] font-semibold leading-snug text-ink"
              title={onRequestRename ? "double-click to rename" : "double-click to open"}
              onDoubleClick={(event) => {
                if (event.shiftKey) return;
                event.preventDefault();
                event.stopPropagation();
                onRequestRename?.();
              }}
            >
              {label}
            </button>
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
      <ClaimedTaskStrip node={node} />
    </div>
  );
}
