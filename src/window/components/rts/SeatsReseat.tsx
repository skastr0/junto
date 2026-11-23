/**
 * The command card's re-seat of several seats: one pick for every selected
 * agent seat, confirmed once for all of them, then one line saying how many
 * moved and which failed. The pick opens in the card's own pop
 * (`rts-cmd-pop`); the harness cascade inside it portals past the bar.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Seat } from "@shared/model";
import { titleOf } from "@shared/model/title";
import {
  harnessDisplayName,
  readSkipReseatConfirm,
  reseatOutcomeLine,
  reseatPickLabel,
  reseatSeats,
  writeSkipReseatConfirm,
} from "../../lib/agent-reseat";
import { claimFocus } from "../../lib/focus-ownership";
import { agentCountLabel } from "../../lib/multi-selection";
import { AgentHarnessPick, type AgentConfigurationChoices } from "../node-palette/AgentHarnessPick";
import { ReseatConfirmDialog } from "./ReseatConfirmDialog";

type Pending = { readonly choices: AgentConfigurationChoices; readonly seats: readonly Seat[] };

export type SeatsReseatLine = { readonly text: string; readonly failed: boolean };

/**
 * Re-seat `seats` onto one pick. `request` confirms first unless the operator
 * turned the confirm off; the seats are the ones selected when the pick was
 * made. `line` says what the last re-seat did.
 */
export function useSeatsReseat(canvas: string, seats: readonly Seat[]): {
  readonly busy: boolean;
  readonly line: SeatsReseatLine | null;
  readonly request: (choices: AgentConfigurationChoices) => void;
  readonly dialog: ReactNode;
} {
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [line, setLine] = useState<SeatsReseatLine | null>(null);

  const run = useCallback(
    async ({ choices, seats: moving }: Pending) => {
      setBusy(true);
      setLine(null);
      const names = new Map<string, string>(moving.map((seat) => [seat.id, titleOf(seat)]));
      const outcome = await reseatSeats(canvas, moving.map((seat) => seat.id), choices);
      setBusy(false);
      setPending(null);
      setLine({
        text: reseatOutcomeLine(outcome, (id) => names.get(id) ?? id),
        failed: outcome.failed.length > 0,
      });
    },
    [canvas],
  );

  const request = useCallback(
    (choices: AgentConfigurationChoices) => {
      const next = { choices, seats };
      setLine(null);
      if (readSkipReseatConfirm()) void run(next);
      else setPending(next);
    },
    [run, seats],
  );

  const only = pending?.seats.length === 1 ? pending.seats[0] : undefined;
  const dialog = pending ? (
    <ReseatConfirmDialog
      count={pending.seats.length}
      {...(only ? { fromLabel: harnessDisplayName(only.harness) } : {})}
      toLabel={reseatPickLabel(pending.choices)}
      onCancel={() => setPending(null)}
      onConfirm={(dontShowAgain) => {
        if (dontShowAgain) writeSkipReseatConfirm(true);
        void run(pending);
      }}
    />
  ) : null;

  return { busy, line, request, dialog };
}

/**
 * The pick for several seats: the harnesses installed on every machine the
 * seats live on, each with its model and effort cascade. Escape closes it.
 */
export function SeatsReseatPick({
  seats,
  onConfigure,
  onClose,
}: {
  readonly seats: readonly Seat[];
  readonly onConfigure: (choices: AgentConfigurationChoices) => void;
  readonly onClose: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    claimFocus(rootRef.current, "open");
  }, []);
  const machines = [...new Set(seats.map((seat) => seat.host))].sort();
  const harnesses = new Set(seats.map((seat) => seat.harness));
  const current = harnesses.size === 1 ? seats[0]?.harness : undefined;
  const label = `Re-seat ${agentCountLabel(seats.length)}`;
  return (
    <div
      ref={rootRef}
      className="seats-reseat-pick"
      role="group"
      aria-label={label}
      tabIndex={-1}
      data-testid="seats-reseat-pick"
      onKeyDown={(event) => {
        // The harness list and its cascade take their own Escape first.
        if (event.key === "Escape" && !event.defaultPrevented) {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key === "ArrowDown" && event.target === rootRef.current) {
          event.preventDefault();
          claimFocus(rootRef.current?.querySelector<HTMLElement>(".agent-harness-pick__item"), "gesture");
        }
      }}
    >
      <div className="seats-reseat-pick__title">
        {label}
        {machines.length > 1 ? <span className="seats-reseat-pick__note"> harnesses on all {machines.length} machines</span> : null}
      </div>
      <AgentHarnessPick
        machines={machines}
        cwd={seats[0]?.launch?.cwd}
        {...(current ? { currentHarness: current } : {})}
        onConfigure={(choices) => {
          onClose();
          onConfigure(choices);
        }}
        listLabel="Harnesses"
      />
    </div>
  );
}
