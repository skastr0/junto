import { useEffect, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { LogOut } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { SeatOffboardAction, SeatOffboardStatus } from "@shared/seat-offboard";
import type { OffboardMode } from "@shared/seat-sessions";
import type { Side } from "../../lib/menu-placement";
import { agentCountLabel, isAgentSeatNode } from "../../lib/multi-selection";
import { nodeTitle } from "../../lib/presentation";
import {
  askOffboardLine,
  offboardIdleLine,
  offboardLineTone,
  offboardNowBlock,
  offboardNowLine,
  offboardPreferred,
  seatOffboardOps,
  type SeatOffboardOps,
} from "../../lib/seat-offboard";
import { state$ } from "../../lib/state";
import { KILL_ARM_MS } from "../../lib/terminal-kill-ux";
import { Button, IconButton, Popover } from "../ui";
import "./seat-offboard.css";

/** How often an open panel asks again how long its seats have sat still. */
const STATUS_REFRESH_MS = 60_000;

type Line = { readonly text: string; readonly tone: "busy" | "done" | "partial" | "refused" };

/**
 * End the session of one agent seat or of every agent in a selection. Two
 * ways: ask the agent, which writes its notes first (continue in a fresh
 * session, or rest), or have Junto close it now with no agent turn and no
 * notes. The cache window says which is the better call for a seat's idle
 * time; both stay available.
 */
export function SeatOffboardPanel({
  nodeIds,
  ops = seatOffboardOps,
}: {
  readonly nodeIds: ReadonlyArray<string>;
  readonly ops?: SeatOffboardOps;
}) {
  const canvasName = use$(state$.canvasName);
  // The agents among the ids, by canvas name, read off the live document.
  const seats = use$(() => {
    const wanted = new Set(nodeIds);
    return state$.doc
      .get()
      .nodes.filter((node) => wanted.has(node.id) && isAgentSeatNode(node))
      .map((node) => ({ id: node.id, name: nodeTitle(node) }));
  });
  const seatKey = seats.map((seat) => seat.id).join(" ");
  const [statuses, setStatuses] = useState<ReadonlyArray<SeatOffboardStatus>>([]);
  const [busy, setBusy] = useState<SeatOffboardAction | undefined>();
  const [line, setLine] = useState<Line | undefined>();
  // Offboard now takes two presses, like stopping a process: the first arms
  // the button for a few seconds, the second closes.
  const [armed, setArmed] = useState(false);
  const armTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
      clearTimeout(armTimer.current);
    },
    [],
  );
  const disarm = (): void => {
    clearTimeout(armTimer.current);
    setArmed(false);
  };
  // A different set of seats is a different question: start unarmed.
  useEffect(disarm, [seatKey]);

  // Main knows whether each seat may be closed now and how long it has sat
  // still. Ask when the panel opens or its seats change, and again each
  // minute while it stays open: the idle clock moves by the minute.
  useEffect(() => {
    const ids = seatKey.split(" ").filter(Boolean);
    if (ids.length === 0) {
      setStatuses([]);
      return;
    }
    let current = true;
    const refresh = (): void => {
      void ops.status(canvasName, ids).then((next) => {
        if (current) setStatuses(next);
      });
    };
    refresh();
    const timer = setInterval(refresh, STATUS_REFRESH_MS);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [canvasName, seatKey, ops]);

  const count = seats.length;
  const many = count > 1;
  const title = many ? `Offboard ${agentCountLabel(count)}` : `Offboard ${seats[0]?.name ?? "agent"}`;
  const idle = offboardIdleLine(statuses);
  const preferred = offboardPreferred(statuses);
  const nowBlock = offboardNowBlock(statuses);

  const pressNow = (): void => {
    if (armed) {
      disarm();
      void run("now", "rest");
      return;
    }
    setArmed(true);
    armTimer.current = setTimeout(() => setArmed(false), KILL_ARM_MS);
  };

  const run = async (action: SeatOffboardAction, mode: OffboardMode): Promise<void> => {
    if (busy !== undefined || count === 0) return;
    disarm();
    setBusy(action);
    setLine({ text: action === "now" ? "Closing…" : "Asking…", tone: "busy" });
    const ids = seats.map((seat) => seat.id);
    const result = await ops.run({ canvasName, seatIds: ids, action, ...(action === "ask" ? { mode } : {}) });
    if (!live.current) return;
    setBusy(undefined);
    setLine({
      text: action === "now" ? offboardNowLine(result.results) : askOffboardLine(mode, result.results),
      tone: offboardLineTone(result.results),
    });
    // A closed seat is no longer idle-with-a-session; ask again what holds.
    void ops.status(canvasName, ids).then((next) => {
      if (live.current) setStatuses(next);
    });
  };

  const disabled = busy !== undefined || count === 0;
  // What the second press will close: the seats main says can be closed now.
  const closable = statuses.length > 0 ? statuses.filter((entry) => entry.now.allowed).length : count;
  const sessions = closable === 1 ? "this session" : `${closable} sessions`;
  return (
    <div className="seat-offboard-panel" data-testid="seat-offboard-panel" data-count={count}>
      <div className="seat-offboard-panel__head">
        <span className="seat-offboard-panel__title">{title}</span>
        {idle ? (
          <span className="seat-offboard-panel__idle" data-testid="seat-offboard-idle">
            {idle}
          </span>
        ) : null}
      </div>

      <div className="seat-offboard-panel__choice" data-preferred={preferred === "ask" ? "true" : undefined}>
        <div className="seat-offboard-panel__buttons">
          <Button
            size="sm"
            variant={preferred === "ask" ? "primary" : "chrome"}
            disabled={disabled}
            onClick={() => void run("ask", "continue")}
            data-testid="seat-offboard-ask-continue"
          >
            Ask to offboard
          </Button>
          <Button
            size="sm"
            variant="subtle"
            disabled={disabled}
            title="Ask the agent to write its notes and end the session; the seat then rests until its next wake"
            onClick={() => void run("ask", "rest")}
            data-testid="seat-offboard-ask-rest"
          >
            Ask, then rest
          </Button>
          {preferred === "ask" ? <PreferredMark /> : null}
        </div>
        <p className="seat-offboard-panel__hint">
          {many ? "Each agent" : "The agent"} writes its notes and ends the session. It continues in a fresh one
          from its own note, unless you choose rest.
        </p>
      </div>

      <div className="seat-offboard-panel__choice" data-preferred={preferred === "now" ? "true" : undefined}>
        <div className="seat-offboard-panel__buttons">
          <Button
            size="sm"
            variant={armed ? "danger" : preferred === "now" ? "primary" : "chrome"}
            disabled={disabled || nowBlock !== undefined}
            aria-label={armed ? `Confirm: close ${sessions} without notes` : undefined}
            aria-describedby={nowBlock !== undefined ? "seat-offboard-now-block" : undefined}
            title={
              armed
                ? `Click again to close ${sessions} without notes`
                : "Close without notes; click twice to confirm"
            }
            onClick={pressNow}
            data-testid="seat-offboard-now"
            data-armed={armed ? "true" : undefined}
          >
            {armed ? `Close ${sessions}?` : "Offboard now"}
          </Button>
          {preferred === "now" ? <PreferredMark /> : null}
        </div>
        {nowBlock !== undefined ? (
          <p id="seat-offboard-now-block" className="seat-offboard-panel__block" data-testid="seat-offboard-now-block">
            {nowBlock}
          </p>
        ) : (
          <p className="seat-offboard-panel__hint">
            Junto closes the session itself: no agent turn, no notes. {many ? "Each seat" : "The seat"} rests on a
            fresh session. Only {many ? "seats" : "a seat"} that {many ? "are" : "is"} idle, offline or resting.
          </p>
        )}
      </div>

      {line ? (
        <p
          className="seat-offboard-panel__status"
          role="status"
          aria-live="polite"
          data-testid="seat-offboard-status"
          data-tone={line.tone}
        >
          {line.text}
        </p>
      ) : null}
    </div>
  );
}

function PreferredMark() {
  return (
    <span
      className="seat-offboard-panel__preferred"
      title="The better call for how long this seat has sat still, by the cache window in Settings"
      data-testid="seat-offboard-preferred"
    >
      preferred
    </span>
  );
}

// Above the toolbar first, centred on the button: below it is the seat itself.
export const OFFBOARD_PANEL_SIDES: ReadonlyArray<Side> = ["above", "below", "right", "left"];
export const OFFBOARD_PANEL_WIDTH = 320;

/** Seat toolbar button, in the small popup above an agent card. */
export function SeatOffboardToolbarAction({ node }: { readonly node: CanvasNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!isAgentSeatNode(node)) return null;
  return (
    <>
      <IconButton
        className="nodrag nopan"
        aria-label="Offboard agent"
        title="Offboard: end this agent's session"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        data-testid="seat-offboard-open"
        onPointerDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          const button = event.currentTarget;
          setAnchor((open) => (open ? null : button));
        }}
      >
        <LogOut size={14} />
      </IconButton>
      {anchor ? (
        <Popover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          label={`Offboard ${nodeTitle(node)}`}
          sides={OFFBOARD_PANEL_SIDES}
          align="center"
          width={OFFBOARD_PANEL_WIDTH}
          className="seat-offboard-popover"
        >
          <SeatOffboardPanel nodeIds={[node.id]} />
        </Popover>
      ) : null}
    </>
  );
}
