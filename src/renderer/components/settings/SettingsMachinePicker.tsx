/**
 * The machine a machine-scoped Settings page is about (docs/machines.md,
 * Harness inventory: "Settings name their machine"). One dropdown in the
 * page's head, every linked machine in it, this one included, each drawn
 * with the figure the Machines window draws for it. A machine that does not
 * answer stays a choice and says so; its page shows what it last sent.
 *
 * Loaded only where the machines surface is on (SettingsPanel).
 */
import { use$ } from "@legendapp/state/react";
import { useEffect, useMemo } from "react";
import { machines$, refreshMachines } from "../../lib/machines-actions";
import {
  machineCondition,
  machineFigureState,
  machineForm,
  type MachineCondition,
  type MachineListItem,
} from "../../lib/machines-view";
import { chooseSettingsMachine, useSettingsMachine } from "../../lib/settings-machine";
import { MachineFigure } from "../machine-figure";
import { Dropdown, type DropdownOption } from "../ui";

const FIGURE = 18;
const NOTHING_PLACED = { seats: 0, harnesses: [] } as const;

/** The state a choice says after its name, when there is one worth saying. */
const STATE_WORD: Partial<Record<MachineCondition, string>> = {
  "this-machine": "this machine",
  checking: "checking",
  "check-failed": "no answer",
  unreachable: "unreachable",
  "needs-update": "needs update",
};

const labelOf = (item: MachineListItem): string => item.machine.label.trim() || item.machine.id;

/** This machine first, then the others by what the operator calls them. */
const linkedInOrder = (items: ReadonlyArray<MachineListItem>): ReadonlyArray<MachineListItem> =>
  items
    .filter((item) => item.machine.isThisMachine || item.setUp)
    .sort((left, right) => {
      if (left.machine.isThisMachine !== right.machine.isThisMachine) return left.machine.isThisMachine ? -1 : 1;
      return labelOf(left).localeCompare(labelOf(right));
    });

export function SettingsMachinePicker() {
  const shown = useSettingsMachine();
  const items = use$(machines$.items);
  const reads = use$(machines$.reads);

  // The same reads the Machines window makes: the list, then each machine.
  useEffect(() => {
    void refreshMachines();
  }, []);

  const options = useMemo<ReadonlyArray<DropdownOption>>(
    () =>
      linkedInOrder(items).map((item) => {
        const read = reads[item.machine.id];
        const condition = machineCondition(item, read, undefined);
        const label = labelOf(item);
        const detail = STATE_WORD[condition];
        return {
          value: item.machine.id,
          label,
          ...(detail === undefined ? {} : { detail }),
          leading: (
            <MachineFigure
              machine={{
                name: item.machine.id,
                label,
                form: machineForm(item, read),
                isThisMachine: item.machine.isThisMachine,
                ...(item.machine.appearance?.color === undefined ? {} : { hue: item.machine.appearance.color }),
              }}
              state={machineFigureState(item, read, undefined, NOTHING_PLACED)}
              size={FIGURE}
              turns={false}
            />
          ),
        };
      }),
    [items, reads],
  );

  const reach =
    shown.isThisMachine ? "this machine" : shown.reachable === false ? "unreachable" : undefined;

  return (
    <div className="settings-machine" data-testid="settings-machine-picker" data-machine={shown.name}>
      <Dropdown
        className="settings-machine__wrap"
        triggerClassName="settings-machine__trigger"
        aria-label={`Settings for ${shown.label}. Choose a machine`}
        title="Whose settings these are"
        value={shown.name}
        options={options}
        placeholder={shown.label}
        emptyLabel="no machines"
        onChange={chooseSettingsMachine}
      />
      {reach ? <span className="settings-machine__state">{reach}</span> : null}
    </div>
  );
}
