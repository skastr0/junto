import { use$ } from "@legendapp/state/react";
import { Radar } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Canvas } from "@shared/model";
import {
  addBoatMachine,
  boatMachine,
  checkMachineAgain,
  copyJunto,
  deleteBoatMachine,
  followMachines,
  machines$,
  openAppUpdates,
  removeMachineAfterConfirm,
  requestMachineUpdate,
  updateAllIdleMachines,
} from "../../lib/machines-actions";
import {
  machinesBarSummary,
  type MachineListItem,
  type MachinesBarEntry,
  type MachinesBarRow,
} from "../../lib/machines-view";
import { openMachines, prefetchMachinesWindow } from "../../lib/machines-window";
import { state$ } from "../../lib/state";
import { KILL_ARM_MS } from "../../lib/terminal-kill-ux";
import { useCanvas } from "../../lib/use-model";
import { Button, Eyebrow, Popover } from "../ui";
import "../feed/operator-feed.css";
import "./machines-attention.css";

// Module-level so Popover's placement effect receives a stable reference.
const POPOVER_SIDES = ["below"] as const;

type Placed = { readonly seats: number; readonly harnesses: ReadonlyArray<string> };
const NOTHING_PLACED: Placed = { seats: 0, harnesses: [] };

const placedByMachine = (canvas: Canvas): ReadonlyMap<string, Placed> => {
  const placed = new Map<string, Placed>();
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "agent") continue;
    const current = placed.get(node.host) ?? NOTHING_PLACED;
    placed.set(node.host, {
      seats: current.seats + 1,
      harnesses: [...current.harnesses, node.harness],
    });
  }
  return placed;
};

const unlistedItem = (id: string, label: string): MachineListItem => ({
  machine: { id, label, isThisMachine: false, capabilities: ["terminal"] },
  setUp: false,
  needsUpdate: false,
});

function PopoverRow({
  row,
  entry,
  pending,
  onOpenMachine,
  onRunAction,
}: {
  readonly row: MachinesBarRow;
  readonly entry: MachinesBarEntry;
  readonly pending: boolean;
  readonly onOpenMachine: (id: string) => void;
  readonly onRunAction: (row: MachinesBarRow, entry: MachinesBarEntry) => Promise<void>;
}) {
  const [armed, setArmed] = useState(false);
  const armTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const disarm = (): void => {
    if (armTimerRef.current !== null) {
      clearTimeout(armTimerRef.current);
      armTimerRef.current = null;
    }
    setArmed(false);
  };

  useEffect(() => disarm, [row.id, row.action?.kind]);

  const handleActionClick = (): void => {
    const action = row.action;
    if (!action || pending) return;
    if (action.danger) {
      if (!armed) {
        setArmed(true);
        armTimerRef.current = setTimeout(() => {
          armTimerRef.current = null;
          setArmed(false);
        }, KILL_ARM_MS);
        return;
      }
      disarm();
    }
    void onRunAction(row, entry);
  };

  const action = row.action;
  const buttonLabel = action
    ? pending && action.pendingLabel
      ? action.pendingLabel
      : armed && action.armedLabel
        ? action.armedLabel
        : action.label
    : undefined;

  return (
    <li
      className="machines-popover__row"
      data-testid={`machines-popover-row-${row.id}`}
      data-severity={row.severity}
      onBlur={(event) => {
        if (armed && !event.currentTarget.contains(event.relatedTarget as Node | null)) {
          disarm();
        }
      }}
    >
      <span
        aria-hidden="true"
        className={`machines-dot machines-dot--${row.severity}`}
        data-testid={`machines-popover-dot-${row.id}`}
      />
      <div className="machines-popover__body">
        <button
          type="button"
          className="machines-popover__label outline-none focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus-ring)]"
          data-testid={`machines-popover-open-${row.id}`}
          onClick={() => onOpenMachine(row.id)}
        >
          {row.label}
        </button>
        <p className="machines-popover__status" title={row.status}>
          {row.status}
        </p>
      </div>
      {action ? (
        <Button
          size="sm"
          variant={action.danger ? "danger" : "chrome"}
          disabled={pending}
          aria-pressed={action.danger ? armed : undefined}
          data-testid={`machines-popover-action-${row.id}`}
          onClick={handleActionClick}
        >
          {buttonLabel}
        </Button>
      ) : null}
    </li>
  );
}

/**
 * TopBar Machines button and popover. Shows live machine attention across the
 * window (static marks, no new motion) and gives one-click fixes in place.
 * Spec: docs/plans/0.11/machines-attention-look.md.
 */
export function MachinesButton() {
  const items = use$(machines$.items);
  const reads = use$(machines$.reads);
  const copies = use$(machines$.copies);
  const boatStatus = use$(machines$.boat);
  const adding = use$(machines$.adding);
  const power = use$(machines$.power);
  const canvas = useCanvas(use$(state$.canvasName));
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [pendingById, setPendingById] = useState<Readonly<Record<string, boolean>>>({});
  const [updatingAll, setUpdatingAll] = useState(false);

  useEffect(() => followMachines(), []);

  const placed = useMemo(() => placedByMachine(canvas), [canvas]);

  // Not memoised over observable maps whose entries mutate in place.
  const entries: ReadonlyArray<MachinesBarEntry> = (() => {
    const names = new Set(items.map((item) => item.machine.id));
    const listedEntries = items.map((item) => {
      const id = item.machine.id;
      return {
        item,
        listed: true,
        read: reads[id],
        copy: copies[id],
        boat: boatMachine(boatStatus, power, id, true),
        placed: placed.get(id) ?? NOTHING_PLACED,
      };
    });
    const unlistedNames = new Map<string, string>();
    for (const [id, label] of Object.entries(adding)) {
      if (!names.has(id)) unlistedNames.set(id, label);
    }
    for (const view of boatStatus?.machines ?? []) {
      if (!names.has(view.machineName) && !unlistedNames.has(view.machineName)) {
        unlistedNames.set(view.machineName, view.machineName);
      }
    }
    const unlistedEntries = [...unlistedNames].map(([id, label]) => ({
      item: unlistedItem(id, label),
      listed: false,
      read: reads[id],
      copy: copies[id],
      boat: boatMachine(boatStatus, power, id, false),
      placed: placed.get(id) ?? NOTHING_PLACED,
    }));
    return [...listedEntries, ...unlistedEntries];
  })();

  const entryById = new Map(entries.map((entry) => [entry.item.machine.id, entry]));
  const summary = machinesBarSummary(entries);
  const open = anchor !== null;

  const iconColor =
    summary.severity === "crimson"
      ? "var(--color-crimson-fg)"
      : summary.severity === "amber"
        ? "var(--color-amber-fg)"
        : "var(--color-steel)";

  const runRowAction = async (row: MachinesBarRow, entry: MachinesBarEntry): Promise<void> => {
    const action = row.action;
    if (!action) return;
    const id = row.id;
    setPendingById((prev) => ({ ...prev, [id]: true }));
    try {
      switch (action.kind) {
        case "send":
          await copyJunto(id, "send");
          return;
        case "update":
          await requestMachineUpdate(entry.item);
          return;
        case "check":
          await checkMachineAgain(entry.item);
          return;
        case "finish": {
          const label = entry.item.machine.label.trim();
          await addBoatMachine({ name: id, ...(label && label !== id ? { label } : {}) });
          return;
        }
        case "check-updates":
          setAnchor(null);
          openAppUpdates();
          return;
        case "delete":
          await deleteBoatMachine(id);
          return;
        case "remove":
          await removeMachineAfterConfirm(entry.item, entry.boat);
          return;
      }
    } finally {
      setPendingById((prev) => {
        const { [id]: _done, ...rest } = prev;
        return rest;
      });
    }
  };

  const runUpdateAll = async (): Promise<void> => {
    if (updatingAll || summary.idleUpdatableNames.length < 2) return;
    const targets = summary.idleUpdatableNames
      .map((id) => entryById.get(id)?.item)
      .filter((item): item is MachineListItem => item !== undefined);
    setUpdatingAll(true);
    try {
      await updateAllIdleMachines(targets);
    } finally {
      setUpdatingAll(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className="station-icon-button operator-feed-trigger"
        data-testid="machines-trigger"
        data-machines-severity={summary.severity}
        aria-label={summary.ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={summary.ariaLabel}
        style={{ borderColor: "var(--color-stroke)", color: iconColor }}
        onPointerEnter={prefetchMachinesWindow}
        onFocus={prefetchMachinesWindow}
        onClick={(event) => setAnchor(open ? null : event.currentTarget)}
      >
        <Radar size={15} aria-hidden="true" />
        {summary.count > 0 ? (
          <span
            className={`operator-feed-trigger__count${summary.severity === "crimson" ? " operator-feed-trigger__count--blocked" : ""}`}
            data-testid="machines-trigger-count"
            aria-hidden="true"
          >
            {summary.count > 99 ? "99+" : summary.count}
          </span>
        ) : summary.severity === "working" ? (
          <span
            className="machines-trigger__working-dot"
            data-testid="machines-trigger-working"
            aria-hidden="true"
          >
            <span className="machines-dot machines-dot--working" />
          </span>
        ) : null}
      </button>
      {anchor ? (
        <Popover
          anchor={anchor}
          onClose={() => setAnchor(null)}
          label="Machines"
          sides={POPOVER_SIDES}
          width={360}
          className="machines-popover"
          testId="machines-popover"
        >
          <div className="machines-popover__head">
            <Eyebrow>Machines</Eyebrow>
          </div>
          {summary.rows.length > 0 ? (
            <ul className="machines-popover__list" data-testid="machines-popover-list">
              {summary.rows.map((row) => {
                const entry = entryById.get(row.id);
                if (!entry) return null;
                return (
                  <PopoverRow
                    key={row.id}
                    row={row}
                    entry={entry}
                    pending={pendingById[row.id] === true}
                    onOpenMachine={(id) => {
                      setAnchor(null);
                      openMachines(id);
                    }}
                    onRunAction={runRowAction}
                  />
                );
              })}
            </ul>
          ) : (
            <p className="machines-popover__empty" data-testid="machines-popover-empty">
              Every machine is ready.
            </p>
          )}
          <div className="machines-popover__foot">
            <Button
              size="sm"
              variant="subtle"
              data-testid="machines-popover-open-all"
              onClick={() => {
                setAnchor(null);
                openMachines();
              }}
            >
              Open Machines
            </Button>
            {summary.idleUpdatableNames.length >= 2 ? (
              <Button
                size="sm"
                variant="primary"
                disabled={updatingAll}
                data-testid="machines-popover-update-all"
                onClick={() => void runUpdateAll()}
              >
                {updatingAll ? "Updating…" : "Update all"}
              </Button>
            ) : null}
          </div>
        </Popover>
      ) : null}
    </>
  );
}
