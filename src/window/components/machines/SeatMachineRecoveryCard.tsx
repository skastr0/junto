import { useState } from "react";
import {
  addBoatMachine,
  checkMachineAgain,
  copyJunto,
  openAppUpdates,
  requestMachineUpdate,
  setBoatPower,
} from "../../lib/machines-actions";
import { MACHINE_STEP_PHASE_WORD } from "../../lib/machines-view";
import { openMachines } from "../../lib/machines-window";
import type { SeatMachineRecovery } from "../../lib/seat-machine-recovery";
import { MachineSteps } from "../machine-figure";
import { Button, Eyebrow } from "../ui";
import "./machines-attention.css";

/**
 * Inline terminal recovery card shown in place of the generic "Agent stopped"
 * card when a remote seat stopped because of its machine.
 * Spec: docs/plans/0.11/machines-attention-look.md §3.
 */
export function SeatMachineRecoveryCard({
  recovery,
  grid,
  onReopen,
  onCloseView,
}: {
  readonly recovery: SeatMachineRecovery;
  readonly grid: boolean;
  readonly onReopen: () => void | Promise<void>;
  readonly onCloseView: () => void;
}) {
  const [pending, setPending] = useState(false);

  const runAction = async (): Promise<void> => {
    if (pending || recovery.running) return;
    const { action, item, hostId, label } = recovery;
    if (action.kind === "open-machines") {
      openMachines(hostId);
      return;
    }
    if (action.kind === "check-updates") {
      openAppUpdates();
      return;
    }
    setPending(true);
    try {
      let ok = false;
      switch (action.kind) {
        case "send":
          ok = (await copyJunto(hostId, "send")) === undefined;
          break;
        case "update":
          ok = item ? await requestMachineUpdate(item) : false;
          break;
        case "wake":
          ok = (await setBoatPower(hostId, "wake")) === undefined;
          break;
        case "check":
          if (item) {
            await checkMachineAgain(item);
            ok = true;
          }
          break;
        case "finish":
          await addBoatMachine({ name: hostId, ...(label !== hostId ? { label } : {}) });
          ok = true;
          break;
      }
      if (ok) await onReopen();
    } finally {
      setPending(false);
    }
  };

  const busy = pending || recovery.running;
  const showSeparateOpenMachines = recovery.action.kind !== "open-machines";
  const primaryLabel = busy && recovery.action.pendingLabel ? recovery.action.pendingLabel : recovery.action.label;

  return (
    <div
      className={`native-terminal-surface__dead-card seat-machine-recovery seat-machine-recovery--${recovery.severity}`}
      data-testid="seat-machine-recovery-card"
      data-machine={recovery.hostId}
      data-recovery-severity={recovery.severity}
      data-recovery-condition={recovery.condition}
    >
      <Eyebrow tone={recovery.eyebrowTone}>{recovery.eyebrow}</Eyebrow>
      <strong className="native-terminal-surface__dead-title">{recovery.headline}</strong>
      <p className="native-terminal-surface__dead-detail">{recovery.detail}</p>
      {recovery.steps.length > 0 ? (
        <MachineSteps
          lines={recovery.steps}
          words={MACHINE_STEP_PHASE_WORD}
          className="machine-steps--inline"
          data-testid="seat-machine-recovery-steps"
        />
      ) : null}
      <div className="native-terminal-surface__dead-actions">
        <Button
          size="sm"
          variant="primary"
          disabled={busy}
          data-testid="seat-machine-recovery-action"
          onClick={() => void runAction()}
        >
          {primaryLabel}
        </Button>
        {showSeparateOpenMachines ? (
          <Button
            size="sm"
            variant="chrome"
            data-testid="seat-machine-recovery-open-machines"
            onClick={() => openMachines(recovery.hostId)}
          >
            Open Machines
          </Button>
        ) : null}
        {!grid ? (
          <Button
            size="sm"
            variant="chrome"
            title="Close view only"
            data-testid="seat-machine-recovery-close"
            onClick={onCloseView}
          >
            Close view
          </Button>
        ) : null}
      </div>
    </div>
  );
}
