import { use$ } from "@legendapp/state/react";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import type { BoatSize } from "@shared/boat";
import { isValidMachineName } from "@shared/machine-identity";
import type { Canvas } from "@shared/model";
import { askConfirm } from "../../lib/confirm";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import {
  addBoatMachine,
  addMachine,
  boatMachine,
  checkMachineAgain,
  connectBoat,
  copyJunto,
  deleteBoatMachine,
  followMachineProgress,
  machines$,
  refreshMachines,
  removeMachine,
  setBoatPower,
} from "../../lib/machines-actions";
import {
  MACHINE_ACTION_LABEL,
  MACHINE_STEP_PHASE_WORD,
  harnessName,
  harnessSignInLine,
  harnessesSeatsLack,
  machineActions,
  machineCondition,
  machineCopyStepLines,
  machineDownloadStepLines,
  machineFigureState,
  machineForm,
  machineHarnessGroups,
  machineHarnesses,
  machineMissingSecrets,
  machineNamed,
  machineStepLines,
  machineSummary,
  machinesNeedingAttention,
  type MachineAction,
  type MachineBoat,
  type MachineCopy,
  type MachineListItem,
  type MachineRead,
} from "../../lib/machines-view";
import { closeMachines } from "../../lib/machines-window";
import { state$ } from "../../lib/state";
import { useCanvas } from "../../lib/use-model";
import { FocusSurface } from "../FocusSurface";
import { MachineFigure, MachineStage, MachineSteps } from "../machine-figure";
import { Button, Dialog, FieldLabel, Input, OverlayHeader } from "../ui";

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

const BOAT_SIZE_LABEL: Readonly<Record<BoatSize, string>> = { small: "Small", default: "Default", large: "Large" };
const BOAT_SIZES: ReadonlyArray<BoatSize> = ["small", "default", "large"];

/** A day as the operator reads it; what does not read as a date is shown as it came. */
const day = (when: string): string => {
  const date = new Date(when);
  return Number.isNaN(date.getTime()) ? when : date.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
};

/** A machine on the shelf: one the list has, or one only Boat or this window's add knows of yet. */
type Shown = { readonly item: MachineListItem; readonly listed: boolean };

const unlistedItem = (id: string, label: string): MachineListItem => ({
  machine: { id, label, isThisMachine: false, capabilities: ["terminal"] },
  setUp: false,
  needsUpdate: false,
});

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
  boat,
  placed,
  selected,
  onSelect,
}: {
  readonly item: MachineListItem;
  readonly read: MachineRead | undefined;
  readonly copy: MachineCopy | undefined;
  readonly boat: MachineBoat | undefined;
  readonly placed: Placed;
  readonly selected: boolean;
  readonly onSelect: () => void;
}) {
  const label = labelOf(item);
  const summary = machineSummary(item, read, copy, placed, boat);
  return (
    <li role="presentation">
      <button
        type="button"
        role="option"
        aria-selected={selected}
        data-testid={`machine-row-${item.machine.id}`}
        data-machine-condition={machineCondition(item, read, copy, boat)}
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
          state={machineFigureState(item, read, copy, placed, boat)}
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
  listed,
  read,
  copy,
  boat,
  placed,
  onAsk,
}: {
  readonly item: MachineListItem;
  readonly listed: boolean;
  readonly read: MachineRead | undefined;
  readonly copy: MachineCopy | undefined;
  readonly boat: MachineBoat | undefined;
  readonly placed: Placed;
  /** The actions that answer in the window's own line: remove, delete, wake and sleep. */
  readonly onAsk: (action: "remove" | "delete" | "wake" | "sleep") => void;
}) {
  const name = item.machine.id;
  const label = labelOf(item);
  const condition = machineCondition(item, read, copy, boat);
  const summary = machineSummary(item, read, copy, placed, boat);
  // "This machine" only ever means the one the window runs on.
  const where = machineNamed(item);
  const steps = [...machineDownloadStepLines(copy), ...machineCopyStepLines(copy), ...machineStepLines(copy)];
  const harnesses = machineHarnesses(read);
  const harnessGroups = harnesses ? machineHarnessGroups(harnesses) : undefined;
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
      // Boat already has the machine, so adding it again picks up where it stopped.
      case "finish":
        return void addBoatMachine({ name, ...(label === name ? {} : { label }) });
      case "remove":
      case "delete":
      case "wake":
      case "sleep":
        return onAsk(action);
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
        state={machineFigureState(item, read, copy, placed, boat)}
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
          {machineActions(condition, boat, listed).map((action) => (
            <Button
              key={action}
              size="sm"
              variant={action === "remove" || action === "delete" ? "subtle" : action === "check" || action === "sleep" ? "chrome" : "primary"}
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
        {boat ? (
          <Fact name="On Boat">
            <span data-testid="machine-boat">
              {BOAT_SIZE_LABEL[boat.size]} size
              {boat.diskKeptUntil && (boat.power === "asleep" || boat.power === "falling-asleep")
                ? `. Boat keeps its disk until ${day(boat.diskKeptUntil)}.`
                : ""}
            </span>
          </Fact>
        ) : item.machine.sshEndpoint ? (
          <Fact name="SSH target">{item.machine.sshEndpoint}</Fact>
        ) : null}
        {read?.kind === "own" ? <Fact name="Build">{read.status.build.slice(0, 12)}</Fact> : null}
        {harnesses ? (
          <Fact name="Harnesses">
            {harnesses.length === 0 || harnessGroups === undefined ? (
              `None found. Install a harness on ${where} to run seats on it.`
            ) : (
              <div className="grid gap-1.5">
                {harnessGroups.shared ? (
                  <>
                    <p data-testid="machine-harnesses-shared" data-harness-state={harnessGroups.shared.state}>
                      {harnessGroups.shared.line}
                    </p>
                    <ul className="grid grid-cols-2 gap-x-6 gap-y-0.5 text-dim" data-testid="machine-harnesses-shared-names">
                      {harnessGroups.shared.harnesses.map((row) => (
                        <li key={row.harness} data-harness={row.harness} data-installed={row.installed} data-sign-in={row.signIn}>
                          {harnessName(row.harness)}
                        </li>
                      ))}
                    </ul>
                  </>
                ) : null}
                {harnessGroups.apart.length > 0 ? (
                  <ul className="grid gap-0.5" data-testid="machine-harnesses">
                    {harnessGroups.apart.map((row) => {
                      const signIn = harnessSignInLine(row);
                      return (
                        <li key={row.harness} data-harness={row.harness} data-installed={row.installed} data-sign-in={row.signIn}>
                          {harnessName(row.harness)}: {row.installed ? "found" : "not found"}
                          {signIn ? <span data-testid="machine-harness-sign-in">. {signIn}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </div>
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

type AddWay = "ssh" | "boat";

function NameField({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <>
      <FieldLabel>
        Name
        <Input
          ref={claimFocusOnMount}
          aria-label="Machine name"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="mac-mini"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </FieldLabel>
      <p className="text-label text-dim">
        The short name that machine goes by. Letters, digits, dots, hyphens and underscores.
      </p>
    </>
  );
}

function LabelField({ value, onChange }: { readonly value: string; readonly onChange: (value: string) => void }) {
  return (
    <FieldLabel>
      Label
      <Input
        aria-label="Machine label"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="What you call it. Optional."
      />
    </FieldLabel>
  );
}

/** Boat says whether it is connected; until it is, the only thing to do is connect. */
function BoatConnect({ onError }: { readonly onError: (message: string) => void }) {
  const boat = use$(machines$.boat);
  const [busy, setBusy] = useState(false);
  if (boat === undefined) {
    return (
      <p className="text-body text-dim" data-testid="machine-add-boat-unavailable">
        Boat could not be asked from this Junto. Use Refresh in the Machines window, then try again.
      </p>
    );
  }
  const connect = async (): Promise<void> => {
    setBusy(true);
    onError("");
    const refused = await connectBoat();
    setBusy(false);
    // The owner's sentence says what to do, a sign-in in a terminal among them.
    if (refused) onError(refused.message);
  };
  return (
    <div className="grid gap-2" data-testid="machine-add-boat-connect">
      <p className="text-body text-ink">
        Connect your Boat account first. Junto uses the boat CLI you are signed in to, and keeps one key for these
        machines on this computer.
      </p>
      <div>
        <Button size="sm" variant="primary" disabled={busy} data-testid="machine-boat-connect" onClick={() => void connect()}>
          {busy ? "Connecting" : "Connect Boat"}
        </Button>
      </div>
    </div>
  );
}

function AddMachineDialog({ onClose, onAdded }: { readonly onClose: () => void; readonly onAdded: (name: string) => void }) {
  const boat = use$(machines$.boat);
  const [way, setWay] = useState<AddWay>("ssh");
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const [label, setLabel] = useState("");
  const [size, setSize] = useState<BoatSize>("small");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmedName = name.trim();
  const boatReady = boat?.connected === true;
  const ready =
    isValidMachineName(trimmedName) && !busy && (way === "ssh" ? target.trim() !== "" : boatReady);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!ready) return;
    const labelled = label.trim() ? { label: label.trim() } : {};
    if (way === "boat") {
      // It takes minutes. The machine waits on the shelf, not in this dialog.
      void addBoatMachine({ name: trimmedName, size, ...labelled });
      onAdded(trimmedName);
      return;
    }
    setBusy(true);
    setError("");
    const refused = await addMachine({ name: trimmedName, sshTarget: target.trim(), ...labelled });
    setBusy(false);
    if (refused) {
      setError(refused.message);
      return;
    }
    onAdded(trimmedName);
  };

  const choose = (next: AddWay): void => {
    setWay(next);
    setError("");
  };

  return (
    <Dialog title="Add a machine" onClose={onClose} testId="machine-add">
      <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
        <div className="flex gap-2" role="group" aria-label="Where the machine is">
          <Button size="sm" variant={way === "ssh" ? "primary" : "subtle"} aria-pressed={way === "ssh"} data-testid="machine-add-way-ssh" onClick={() => choose("ssh")}>
            Over SSH
          </Button>
          <Button size="sm" variant={way === "boat" ? "primary" : "subtle"} aria-pressed={way === "boat"} data-testid="machine-add-way-boat" onClick={() => choose("boat")}>
            On Boat
          </Button>
        </div>
        {way === "boat" && !boatReady ? <BoatConnect onError={setError} /> : null}
        {way === "ssh" || boatReady ? <NameField value={name} onChange={setName} /> : null}
        {way === "ssh" ? (
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
        ) : null}
        {way === "ssh" || boatReady ? <LabelField value={label} onChange={setLabel} /> : null}
        {way === "boat" && boatReady ? (
          <>
            <div className="grid gap-1">
              <span className="text-body-lg text-dim">Size</span>
              <div className="flex gap-2" role="group" aria-label="Size">
                {BOAT_SIZES.map((option) => (
                  <Button
                    key={option}
                    size="sm"
                    variant={size === option ? "primary" : "subtle"}
                    aria-pressed={size === option}
                    data-testid={`machine-add-size-${option}`}
                    onClick={() => setSize(option)}
                  >
                    {BOAT_SIZE_LABEL[option]}
                  </Button>
                ))}
              </div>
            </div>
            <p className="text-label text-dim">
              Junto makes the machine on your Boat account and sends Junto to it, which takes a few minutes. It gets
              none of your Boat secrets, and it sleeps when no seat is working on it.
            </p>
          </>
        ) : null}
        {error ? (
          <p className="text-body text-crimson-fg" role="alert" data-testid="machine-add-error">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="subtle" onClick={onClose}>
            Cancel
          </Button>
          {way === "ssh" || boatReady ? (
            <Button size="sm" variant="primary" type="submit" disabled={!ready}>
              {busy ? "Adding" : way === "boat" ? "Add on Boat" : "Add machine"}
            </Button>
          ) : null}
        </div>
      </form>
    </Dialog>
  );
}

/** Ask, then remove. Resolves to the owner's refusal in its own words, or nothing. */
const removeAfterConfirm = async (item: MachineListItem, boat: MachineBoat | undefined): Promise<string> => {
  const label = labelOf(item);
  const confirmed = await askConfirm({
    source: "machine-remove",
    title: `Remove ${label}?`,
    body: [
      `This machine stops reaching ${label}. Its seats stay on the canvas and cannot run until you add it again.`,
      boat === undefined
        ? `Junto stays installed on ${label}.`
        : `${label} stays on Boat, asleep${boat.diskKeptUntil ? `, and Boat keeps its disk until ${day(boat.diskKeptUntil)}` : ""}. Delete it on Boat to remove it there too.`,
    ],
    confirmLabel: "Remove machine",
    tone: "danger",
  });
  if (!confirmed) return "";
  const refused = await removeMachine(item.machine.id);
  return refused ? refused.message : "";
};

/** Ask, then remove the machine and delete it on Boat. */
const deleteAfterConfirm = async (item: MachineListItem, listed: boolean): Promise<string> => {
  const label = labelOf(item);
  const confirmed = await askConfirm({
    source: "machine-boat-delete",
    title: `Delete ${label} on Boat?`,
    body: [
      listed
        ? `This machine stops reaching ${label}, and Boat deletes it with its disk. Its seats stay on the canvas and cannot run.`
        : `Boat deletes ${label} with its disk. It was never added to your machines.`,
      "This cannot be undone.",
    ],
    confirmLabel: "Delete on Boat",
    tone: "danger",
  });
  if (!confirmed) return "";
  const refused = await deleteBoatMachine(item.machine.id);
  return refused ? refused.message : "";
};

const ask = async (
  entry: Shown,
  boat: MachineBoat | undefined,
  action: "remove" | "delete" | "wake" | "sleep",
): Promise<string> => {
  const item = entry.item;
  switch (action) {
    case "remove":
      return removeAfterConfirm(item, boat);
    case "delete":
      return deleteAfterConfirm(item, entry.listed);
    case "wake":
    case "sleep": {
      const refused = await setBoatPower(item.machine.id, action);
      return refused ? refused.message : "";
    }
  }
};

function MachinesWindowOpen() {
  const items = use$(machines$.items);
  const reads = use$(machines$.reads);
  const copies = use$(machines$.copies);
  const boatStatus = use$(machines$.boat);
  const adding = use$(machines$.adding);
  const power = use$(machines$.power);
  const loading = use$(machines$.loading);
  const error = use$(machines$.error);
  const canvas = useCanvas(use$(state$.canvasName));
  const [selected, setSelected] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    void refreshMachines();
    return followMachineProgress();
  }, []);

  const placed = useMemo(() => placedByMachine(canvas), [canvas]);
  // The list's machines, then the ones Boat or an add in flight knows of and the list does not yet.
  // Not memoised: the store changes these records in place, so their identity says nothing.
  const shown = ((): ReadonlyArray<Shown> => {
    const listed = inOrder(items);
    const names = new Set(listed.map((item) => item.machine.id));
    const unlisted = new Map<string, string>();
    for (const [name, label] of Object.entries(adding)) if (!names.has(name)) unlisted.set(name, label);
    for (const view of boatStatus?.machines ?? []) {
      if (!names.has(view.machineName) && !unlisted.has(view.machineName)) unlisted.set(view.machineName, view.machineName);
    }
    return [
      ...listed.map((item) => ({ item, listed: true })),
      ...[...unlisted].sort(([left], [right]) => left.localeCompare(right)).map(([name, label]) => ({ item: unlistedItem(name, label), listed: false })),
    ];
  })();
  const boatOf = (entry: Shown) => boatMachine(boatStatus, power, entry.item.machine.id, entry.listed);
  const current = shown.find((entry) => entry.item.machine.id === selected) ?? shown[0];
  const others = shown.filter((entry) => !entry.item.machine.isThisMachine);
  const attention = machinesNeedingAttention(
    shown.map((entry) =>
      machineSummary(
        entry.item,
        reads[entry.item.machine.id],
        copies[entry.item.machine.id],
        placed.get(entry.item.machine.id) ?? NOTHING_PLACED,
        boatOf(entry),
      ),
    ),
  );
  const unrevoked = boatStatus?.unrevokedKeyIds ?? [];
  const status = error
    ? "Could not read the machines"
    : loading && shown.length === 0
      ? "Reading"
      : `${shown.length} ${shown.length === 1 ? "machine" : "machines"}${
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
            <Button size="sm" variant="primary" data-testid="machines-add" onClick={() => setAddOpen(true)}>
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
      {actionError ? (
        <p className="border-b border-stroke px-4 py-2 text-body text-crimson-fg" role="alert" data-testid="machine-remove-error">
          {actionError}
        </p>
      ) : null}
      {unrevoked.length > 0 ? (
        <p className="border-b border-stroke px-4 py-2 text-body text-ink" role="status" data-testid="machines-boat-unrevoked">
          Junto could not revoke {unrevoked.length === 1 ? "this Boat key" : "these Boat keys"}: {unrevoked.join(", ")}. Revoke{" "}
          {unrevoked.length === 1 ? "it" : "them"} in your Boat account.
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-[340px] shrink-0 flex-col overflow-y-auto border-r border-stroke" aria-label="Machines">
          <ul className="machine-shelf" role="listbox" aria-label="Machines">
            {shown.map((entry) => (
              <MachineRow
                key={entry.item.machine.id}
                item={entry.item}
                read={reads[entry.item.machine.id]}
                copy={copies[entry.item.machine.id]}
                boat={boatOf(entry)}
                placed={placed.get(entry.item.machine.id) ?? NOTHING_PLACED}
                selected={entry.item.machine.id === current?.item.machine.id}
                onSelect={() => setSelected(entry.item.machine.id)}
              />
            ))}
          </ul>
          {shown.length > 0 && others.length === 0 ? (
            <p className="machine-shelf__empty mx-3 mb-3" data-testid="machines-empty">
              No other machine yet. Add one by its name and SSH target, or make one on Boat.
            </p>
          ) : null}
        </aside>
        {current ? (
          <MachineDetail
            key={current.item.machine.id}
            item={current.item}
            listed={current.listed}
            read={reads[current.item.machine.id]}
            copy={copies[current.item.machine.id]}
            boat={boatOf(current)}
            placed={placed.get(current.item.machine.id) ?? NOTHING_PLACED}
            onAsk={(action) => {
              setActionError("");
              void ask(current, boatOf(current), action).then(setActionError);
            }}
          />
        ) : (
          <div className="grid flex-1 place-items-center p-6 text-body text-dim">
            {loading ? "Reading the machines" : "No machine to show."}
          </div>
        )}
      </div>
      {addOpen ? (
        <AddMachineDialog
          onClose={() => setAddOpen(false)}
          onAdded={(name) => {
            setAddOpen(false);
            setSelected(name);
          }}
        />
      ) : null}
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
