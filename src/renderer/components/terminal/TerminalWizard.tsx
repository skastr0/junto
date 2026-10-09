import { useEffect, useState } from "react";
import { TERMINAL_HOST_CAPABILITY } from "@shared/remote-hosts";
import { resolveRegionCwd } from "@shared/region-defaults";
import { newTerminal } from "../../lib/model-factories";
import { topZ } from "../../lib/model-edits";
import { addNode } from "../../lib/mutations";
import { modelStore } from "../../lib/use-model";
import { state$ } from "../../lib/state";
import { openTerminal } from "../../lib/terminal-actions";
import { loadSetUpMachines, machineChoices, thisMachineName, type MachineChoice } from "../../lib/machines";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { Button, Dialog, FieldLabel, Select } from "../ui";

const TERMINAL_SIZE = { width: 260, height: 110 } as const;

/** Create a terminal node at the anchor and open it, on this machine unless one is named. */
export const createTerminalAt = (
  anchor: { readonly x: number; readonly y: number },
  machine: string = thisMachineName(),
): Promise<void> => {
  const host = machine || thisMachineName();
  // Create-time cwd from the containing region's folder for the chosen machine.
  const cwd = resolveRegionCwd(
    modelStore.canvasOf(state$.canvasName.peek()),
    anchor.x + TERMINAL_SIZE.width / 2,
    anchor.y + TERMINAL_SIZE.height / 2,
    host,
  );
  const node = newTerminal({ ...anchor, z: topZ(modelStore.canvasOf(state$.canvasName.peek())) }, {
    launch: { kind: "shell", ...(cwd ? { cwd } : {}) }, label: "terminal", host,
  });
  addNode(node, { edit: false });
  state$.focusNodeId.set(node.id);
  return openTerminal(state$.canvasName.peek(), node.id);
};

export function TerminalWizard({
  anchor,
  onClose,
}: {
  readonly anchor: { x: number; y: number };
  readonly onClose: () => void;
}) {
  const [machines, setMachines] = useState<ReadonlyArray<MachineChoice>>(() =>
    machineChoices([], thisMachineName()),
  );
  const [machine, setMachine] = useState(thisMachineName);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    // Only a machine that is set up is offered: nothing could start on another.
    void loadSetUpMachines().then((listed) => {
      if (!live) return;
      const name = thisMachineName();
      // This machine can always run a terminal; another must say it can.
      const next = machineChoices(
        listed.filter(
          (row) => row.isThisMachine || row.capabilities.includes(TERMINAL_HOST_CAPABILITY),
        ),
        name,
      );
      setMachines(next);
      setMachine((current) => (next.some((row) => row.id === current) ? current : name));
    });
    return () => {
      live = false;
    };
  }, []);

  const create = () => {
    if (busy) return;
    setBusy(true);
    void createTerminalAt(anchor, machine).finally(() => {
      setBusy(false);
      onClose();
    });
  };

  // The shared dialog, like New canvas. Create holds the keyboard on open, so
  // Enter makes the terminal on this machine at once.
  return (
    <Dialog
      title="New terminal"
      onClose={onClose}
      actions={
        <>
          <Button size="md" variant="chrome" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button ref={claimFocusOnMount} size="md" variant="primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create terminal"}
          </Button>
        </>
      }
    >
      <FieldLabel>
        Machine
        <Select
          aria-label="Machine"
          value={machine}
          options={machines.map((row) => ({ value: row.id, label: row.label }))}
          onChange={setMachine}
        />
      </FieldLabel>
    </Dialog>
  );
}
