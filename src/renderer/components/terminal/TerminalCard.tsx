import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { ListChecks, SquareTerminal } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { TerminalSessionSummary } from "@shared/terminal";
import { resolveTerminalBinding } from "@shared/terminal";
import { agentSeat$, subscribeAgentSeatState } from "../../lib/agent-seat-state";
import { terminalActivity } from "../../lib/activity";
import { terminal$ } from "../../lib/terminal-state";
import { terminalTail$, subscribeTerminalTail } from "../../lib/terminal-tail";
import { getVellumApi } from "../../lib/vellum-api";
import { claimedTaskForActorNode } from "../../lib/claimed-task";
import { state$ } from "../../lib/state";
import { releaseTaskToQueue } from "../../lib/work-actions";
import { taskBrief } from "@shared/task";
import { ExecutionCardHeader } from "../nodes/ExecutionCardHeader";
import { Button } from "../ui";

/** Header + subtitle + hostId row, in px — space the tail preview must not eat. */
const TAIL_CHROME_RESERVED_PX = 60;
const TAIL_LINE_HEIGHT_PX = 14;
/** Never more than this many lines, no matter how tall the card grows. */
const TAIL_MAX_LINES = 8;

/** How many trailing lines fit a card of this height — 0 when there's no room. */
const tailLineBudget = (nodeHeight: number): number => {
  const available = nodeHeight - TAIL_CHROME_RESERVED_PX;
  if (available < TAIL_LINE_HEIGHT_PX * 2) return 0;
  return Math.min(TAIL_MAX_LINES, Math.floor(available / TAIL_LINE_HEIGHT_PX));
};

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
}: {
  readonly node: CanvasNode;
  /** Execution-graph blocked — crimson spinner even when seat is idle. */
  readonly graphBlocked?: boolean;
}) {
  const binding = resolveTerminalBinding(node);
  const native = binding?.kind === "native" ? binding : undefined;
  const [session, setSession] = useState<TerminalSessionSummary>();
  const [releasePending, setReleasePending] = useState(false);
  const [releaseError, setReleaseError] = useState("");
  const canvasName = use$(state$.canvasName);
  const doc = use$(state$.doc);
  const actorRefs = use$(state$.actorRefs);
  const claimedTask = claimedTaskForActorNode(doc, actorRefs, node.id);
  const seatEvent = use$(
    agentSeat$.byBindingId[
      native?.bindingId ?? "__vellum-terminal-no-binding__"
    ],
  );
  const tailEvent = use$(
    terminalTail$.byBindingId[
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
    subscribeTerminalTail();
    void refresh();
    const api = getVellumApi();
    const off = api?.onTerminalEvent?.((raw) => {
      if ((raw as { bindingId?: string }).bindingId === native?.bindingId)
        void refresh();
    });
    // Poll only while running — lease-scoped events don't reach cards without
    // an open surface.
    if (!running) {
      return () => off?.();
    }
    const timer = window.setInterval(() => {
      void refresh();
    }, 2500);
    return () => {
      off?.();
      window.clearInterval(timer);
    };
  }, [native?.bindingId, native?.hostId, running]);

  if (!native)
    return <div className="text-[11px] text-dim">unbound terminal</div>;

  const label = native.label ?? (node.type === "text" ? node.text : "terminal");
  const seatState = seatEvent?.state;
  const activity = terminalActivity({
    seatState,
    running: session?.status === "running",
    starting: session?.status === "starting",
    graphBlocked,
  });

  const tailBudget = tailLineBudget(node.height);
  const tailLines =
    running && tailBudget > 0 && tailEvent?.lines.length
      ? tailEvent.lines.slice(-tailBudget)
      : undefined;
  const releaseClaim = async (): Promise<void> => {
    if (!claimedTask || releasePending) return;
    setReleasePending(true);
    setReleaseError("");
    try {
      const result = await releaseTaskToQueue(
        canvasName,
        claimedTask.sinkNodeId,
        claimedTask.task.id,
      );
      if (result && !result.ok) setReleaseError(result.message);
    } catch (cause) {
      setReleaseError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReleasePending(false);
    }
  };

  return (
    <div
      className="group flex h-full w-full flex-col overflow-hidden"
      title="double-click to open"
      data-seat-state={seatState}
    >
      <div>
        <ExecutionCardHeader
          decal={
            <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
              <SquareTerminal size={15} />
            </div>
          }
          title={label}
          subtitle={launchSummary(native.launch)}
          activity={
            seatState === "attention" && seatEvent?.reason
              ? { ...activity, label: seatEvent.reason }
              : activity
          }
        />
        <div className="mt-1 truncate text-[10px] tabular-nums text-dim">
          {native.hostId}
        </div>
      </div>
      {claimedTask ? (
        <div
          className="mt-1.5 flex min-w-0 items-center gap-1.5 rounded border border-cyan/20 bg-cyan/[0.06] px-1.5 py-1 text-[10px]"
          title={releaseError || `Claimed task ${claimedTask.task.id}`}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <ListChecks size={11} className="shrink-0 text-cyan" aria-hidden />
          <span className="min-w-0 flex-1 truncate text-ink">
            {taskBrief(claimedTask.task)}
          </span>
          <Button
            size="xs"
            variant="subtle"
            disabled={releasePending}
            onClick={() => void releaseClaim()}
          >
            {releasePending ? "…" : "Unclaim"}
          </Button>
        </div>
      ) : null}
      {tailLines ? (
        <div
          className="terminal-card__tail mt-1.5 min-h-0 flex-1 overflow-hidden font-mono text-[10px] leading-snug text-dim/70"
          style={{
            maskImage: "linear-gradient(to bottom, transparent, black 28px)",
            WebkitMaskImage: "linear-gradient(to bottom, transparent, black 28px)",
          }}
          aria-hidden="true"
        >
          {tailLines.map((line, i) => (
            <div key={i} className="truncate whitespace-pre">
              {line || " "}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
