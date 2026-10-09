import { use$ } from "@legendapp/state/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { isValidMachineName } from "@shared/machine-identity";
import type { Canvas } from "@shared/model";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import {
  addMachine,
  checkMachineAgain,
  copyJunto,
  followMachineProgress,
  machines$,
  refreshMachines,
  removeMachine,
} from "../../lib/machines-actions";
import {
  MACHINE_ACTION_LABEL,
  MACHINE_STEP_PHASE_WORD,
  harnessName,
  harnessesSeatsLack,
  machineActions,
  machineCondition,
  machineFigureState,
  machineForm,
  machineHarnesses,
  machineMissingSecrets,
  machineNamed,
  machineStepLines,
  machineSummary,
  machinesNeedingAttention,
  type MachineAction,
  type MachineCopy,
  type MachineListItem,
  type MachineRead,
} from "../../lib/machines-view";
import { closeMachines } from "../../lib/machines-window";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { FocusSurface } from "../FocusSurface";
import { MachineFigure, MachineStage, MachineSteps } from "../machine-figure";
import { Button, ConfirmDialog, Dialog, FieldLabel, Input, OverlayHeader } from "../ui";

// The Machines window: every machine this one knows, what state each is in,
// and the four things the operator can do about it (add, send Junto, update,
// remove). The machines stand on a shelf, each a figure with its name and one
// line of state; the chosen one is given the stage, with the seats placed on
// it standing on its roof. How a machine looks is the figure's, and the
// figure takes a machine, its state and a size.

/** What is placed on a machine on the open canvas: its seats, and the harnesses they use. */
type Placed = { readonly seats: number; readonly harnesses: ReadonlyArray<string>; readonly seatIds: ReadonlyArray<string> };
const NOTHING_PLACED: Placed = { seats: 0, harnesses: [], seatIds: [] };

/** On the shelf a machine stands as a solid, large enough to carry its state. */
const SHELF_FIGURE = 104;

const placedByMachine = (canvas: Canvas): ReadonlyMap<string, Placed> => {
  const placed = new Map<string, Placed>();
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "agent") continue;
    const current = placed.get(node.host) ?? NOTHING_PLACED;
    placed.set(node.host, {
      seats: current.seats + 1,
      harnesses: [...current.harnesses, node.harness],
      seatIds: [...current.seatIds, node.id],
    });
  }
  return placed;
};

const labelOf = (item: MachineListItem): string => item.machine.label.trim() || item.machine.id;

/** This machine first, then the others by what the operator calls them. */
const inOrder = (items: ReadonlyArray<MachineListItem>): ReadonlyArray<MachineListItem> =>
  [...items].sort((left, right) => {
    if (left.machine.isThisMachine !== right.machine.isThisMachine) return left.machine.isThisMachine ? -1 : 1;
    return labelOf(left).localeCompare(labelOf(right));
  });

function MachineRow({
  item,
  read,
  copy,
  placed,
  selected,
  onSelect,
}: {
  readonly item: MachineListItem;
  readonly read: MachineRead | undefined;
  readonly copy: MachineCopy | undefined;
  readonly placed: Placed;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const label = labelOf(item);
  const summary = machineSummary(item, read, copy, placed);
  return (
    <li role="presentation">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        data-testid={`machine-row-${item.machine.id}`}
        data-machine-condition={machineCondition(item, read, copy)}
        data-needs-you={summary.needsYou}
        className="machine-shelf__place"
        onClick={onSelect}
      >
        <MachineFigure
          machine={{
            name: item.machine.id,
            label,
            form: machineForm(item, read),
            isThisMachine: item.machine.isThisMachine,
          }}
          state={machineFigureState(item, read, copy, placed)}
          size={SHELF_FIGURE}
          turns={false}
        />
        <span className="machine-shelf__name">{label}</span>
        <span className="machine-shelf__state">{summary.headline}</span>
      </button>
    </li>
  );
}

function Fact({ name, children }: { readonly name: string; readonly children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-body-lg text-dim">{name}</dt>
      <dd className="min-w-0 text-body-lg leading-normal text-ink">{children}</dd>
    </div>
  );
}

function MachineDetail({
  item,
  read,
  copy,
  placed,
  onRemove,
}: {
  readonly item: MachineListItem;
  readonly read: MachineRead | undefined;
  readonly copy: MachineCopy | undefined;
  readonly placed: Placed;
  readonly onRemove: () => void;
}) {
  const name = item.machine.id;
  const label = labelOf(item);
  const condition = machineCondition(item, read, copy);
  const summary = machineSummary(item, read, copy, placed);
  // "This machine" only ever means the one the window runs on.
  const where = machineNamed(item);
  const steps = machineStepLines(copy);
  const harnesses = machineHarnesses(read);
  const lacking = harnessesSeatsLack(read, placed.harnesses);
  const missingSecrets = machineMissingSecrets(read);

  const run = (action: MachineAction): void => {
    switch (action) {
      case "send":
        return void copyJunto(name, "send");
      case "update":
        return void copyJunto(name, "update");
      case "check":
        return void checkMachineAgain(item);
      case "remove":
        return onRemove();
    }
  };

  return (
    <section
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
      aria-label={label}
      data-testid="machine-detail"
      data-machine={name}
      data-machine-condition={condition}
      data-needs-you={summary.needsYou}
    >
      <MachineStage
        machine={{ name, label, form: machineForm(item, read), isThisMachine: item.machine.isThisMachine }}
        state={machineFigureState(item, read, copy, placed)}
        seatIds={placed.seatIds}
      >
        <div className="machine-stage__eyebrow">{name}</div>
        <h2 className="machine-stage__label">{label}</h2>
        <p className="machine-stage__headline" role="status" data-testid="machine-headline">
          {summary.headline}
        </p>
        {summary.advice ? (
          <p className="machine-stage__advice" data-testid="machine-advice">
            {summary.advice}
          </p>
        ) : null}
        <div className="machine-stage__actions">
          {machineActions(condition).map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "remove" ? "subtle" : action === "check" ? "chrome" : "primary"}
              data-testid={`machine-action-${action}`}
              onClick={() => run(action)}
            >
              {MACHINE_ACTION_LABEL[action]}
            </Button>
          ))}
        </div>
      </MachineStage>

      {steps.length > 0 ? <MachineSteps lines={steps} words={MACHINE_STEP_PHASE_WORD} data-testid="machine-steps" /> : null}

      <dl className="machine-facts">
        {item.machine.sshEndpoint ? <Fact name="SSH target">{item.machine.sshEndpoint}</Fact> : null}
        {read?.kind === "own" ? <Fact name="Build">{read.status.build.slice(0, 12)}</Fact> : null}
        {harnesses ? (
          <Fact name="Harnesses">
            {harnesses.length === 0 ? (
              `None found. Install a harness on ${where} to run seats on it.`
            ) : (
              <ul className="grid gap-0.5" data-testid="machine-harnesses">
                {harnesses.map((row) => (
                  <li key={row.harness} data-harness={row.harness} data-installed={row.installed}>
                    {harnessName(row.harness)}: {row.installed ? "found" : "not found"}
                  </li>
                ))}
              </ul>
            )}
          </Fact>
        ) : null}
        {lacking.length > 0 ? (
          <Fact name="Seats need">
            <span data-testid="machine-harnesses-lacking">
              {lacking.map(harnessName).join(", ")}. Install {lacking.length === 1 ? "it" : "them"} on {where}, or move those seats.
            </span>
          </Fact>
        ) : null}
        {missingSecrets.length > 0 ? (
          <Fact name="Missing secrets">
            <span data-testid="machine-missing-secrets">
              {missingSecrets.join(", ")}. Set {missingSecrets.length === 1 ? "it" : "them"} on {where}. Junto never sends a secret between machines.
            </span>
          </Fact>
        ) : null}
        <Fact name="Seats">
          {placed.seats === 0
            ? "None on this canvas"
            : `${placed.seats} on this canvas`}
        </Fact>
      </dl>
    </section>
  );
}

function AddMachineDialog({ onClose, onAdded }: { readonly onClose: () => void; readonly onAdded: (name: string) => void }) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmedName = name.trim();
  const ready = isValidMachineName(trimmedName) && target.trim() !== "" && !busy;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    setBusy(true);
    setError("");
    const refused = await addMachine({
      name: trimmedName,
      sshTarget: target.trim(),
      ...(label.trim() ? { label: label.trim() } : {}),
    });
    setBusy(false);
    if (refused) {
      setError(refused.message);
      return;
    }
    onAdded(trimmedName);
  };

  return (
    <Dialog title="Add a machine" onClose={onClose} testId="machine-add">
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <FieldLabel>
          Name
          <Input
            ref={claimFocusOnMount}
            aria-label="Machine name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="mac-mini"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </FieldLabel>
        <p className="text-label text-dim">
          The short name that machine goes by. Letters, digits, dots, hyphens and underscores.
        </p>
        <FieldLabel>
          SSH target
          <Input
            aria-label="SSH target"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder="user@host, or a name from your SSH config"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
          />
        </FieldLabel>
        <FieldLabel>
          Label
          <Input
            aria-label="Machine label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="What you call it. Optional."
          />
        </FieldLabel>
        {error ? (
          <p className="text-body text-crimson-fg" role="alert" data-testid="machine-add-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" type="submit" disabled={!ready}>
            {busy ? "Adding" : "Add machine"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RemoveMachineDialog({ item, onClose }: { readonly item: MachineListItem; readonly onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const label = labelOf(item);

  const confirm = async (): Promise<void> => {
    setBusy(true);
    setError("");
    const refused = await removeMachine(item.machine.id);
    setBusy(false);
    if (refused) {
      setError(refused.message);
      return;
    }
    onClose();
  };

  return (
    <ConfirmDialog
      title={`Remove ${label}?`}
      confirmLabel="Remove machine"
      busy={busy}
      onConfirm={() => void confirm()}
      onCancel={onClose}
      testId="machine-remove"
    >
      <p>
        This machine stops reaching {label}. Its seats stay on the canvas and cannot run until you add it again.
        Junto stays installed on {label}.
      </p>
      {error ? (
        <p className="mt-2 text-crimson-fg" role="alert" data-testid="machine-remove-error">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}

function MachinesWindowOpen() {
  const items = use$(machines$.items);
  const reads = use$(machines$.reads);
  const copies = use$(machines$.copies);
  const loading = use$(machines$.loading);
  const error = use$(machines$.error);
  const canvas = useCanvas(use$(state$.canvasName));
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState("");

  useEffect(() => {
    void refreshMachines();
    return followMachineProgress();
  }, []);

  const placed = useMemo(() => placedByMachine(canvas), [canvas]);
  const ordered = useMemo(() => inOrder(items), [items]);
  const current = ordered.find((item) => item.machine.id === selected) ?? ordered[0];
  const removingItem = ordered.find((item) => item.machine.id === removing);
  const others = ordered.filter((item) => !item.machine.isThisMachine);
  const attention = machinesNeedingAttention(
    ordered.map((item) =>
      machineSummary(item, reads[item.machine.id], copies[item.machine.id], placed.get(item.machine.id) ?? NOTHING_PLACED),
    ),
  );
  const status = error
    ? "Could not read the machines"
    : loading && ordered.length === 0
      ? "Reading"
      : `${ordered.length} ${ordered.length === 1 ? "machine" : "machines"}${
          attention > 0 ? `, ${attention} ${attention === 1 ? "needs" : "need"} you` : ""
        }`;

  return (
    <FocusSurface measure="workspace" height="immersive" label="Machines" onClose={closeMachines}>
      <OverlayHeader
        title="Machines"
        status={<span data-testid="machines-status">{status}</span>}
        actions={
          <>
            <Button size="sm" variant="subtle" disabled={loading} onClick={() => void refreshMachines()}>
              Refresh
            </Button>
            <Button size="sm" variant="primary" data-testid="machines-add" onClick={() => setAdding(true)}>
              Add machine
            </Button>
          </>
        }
      />
      {error ? (
        <p className="border-b border-stroke px-4 py-2 text-body text-crimson-fg" role="alert" data-testid="machines-error">
          {error}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-stroke" aria-label="Machines">
          <ul className="machine-shelf" role="listbox" aria-label="Machines">
            {ordered.map((item) => (
              <MachineRow
                key={item.machine.id}
                item={item}
                read={reads[item.machine.id]}
                copy={copies[item.machine.id]}
                placed={placed.get(item.machine.id) ?? NOTHING_PLACED}
                selected={item.machine.id === current?.machine.id}
                onSelect={() => setSelected(item.machine.id)}
              />
            ))}
          </ul>
          {ordered.length > 0 && others.length === 0 ? (
            <p className="machine-shelf__empty mx-3 mb-3" data-testid="machines-empty">
              No other machine yet. Add one by its name and SSH target, then send Junto to it.
            </p>
          ) : null}
        </aside>
        {current ? (
          <MachineDetail
            key={current.machine.id}
            item={current}
            read={reads[current.machine.id]}
            copy={copies[current.machine.id]}
            placed={placed.get(current.machine.id) ?? NOTHING_PLACED}
            onRemove={() => setRemoving(current.machine.id)}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-body text-dim">
            {loading ? "Reading the machines" : "No machine to show."}
          </div>
        )}
      </div>
      {adding ? (
        <AddMachineDialog
          onClose={() => setAdding(false)}
          onAdded={(name) => {
            setAdding(false);
            setSelected(name);
          }}
        />
      ) : null}
      {removingItem ? <RemoveMachineDialog item={removingItem} onClose={() => setRemoving("")} /> : null}
    </FocusSurface>
  );
}

/**
 * The Machines window. App mounts it only while it is open, so none of it
 * loads at startup; the check here keeps that true if a caller forgets.
 */
export function MachinesWindow() {
  const open = use$(state$.machinesOpen);
  if (!open) return null;
  return <MachinesWindowOpen />;
}
