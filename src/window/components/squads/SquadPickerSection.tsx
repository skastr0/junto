import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { Squad } from "@shared/squads";
import { SQUAD_NAME_MAX } from "@shared/squads";
import { squadSummary } from "../../lib/squads";
import { deleteSquad, ensureSquads, renameSquad, squads$ } from "../../lib/squads-state";
import { PickerCard, PickerCardGrid, PickerCardManage } from "../ui";
import { SquadPortraitStack } from "./SquadPortraitRow";
import "./squads.css";

/** Who is on the team, by name, for the card's second line. */
const rosterLine = (squad: Squad): string => squad.seats.map((seat) => seat.profile.name).join(", ");

/**
 * Squads in the add picker: one card per squad (stacked faces, name, size,
 * who is on it). A click places it; the card's menu (or a right-click)
 * renames or deletes it. Hidden while there are no squads.
 */
export function SquadPickerSection({
  query,
  onPlace,
}: {
  readonly query: string;
  readonly onPlace: (squadId: string) => void;
}) {
  useEffect(ensureSquads, []);
  const squads = use$(squads$.list);
  const [managing, setManaging] = useState<{ readonly squad: Squad; readonly anchor: HTMLElement } | null>(null);
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? squads.filter((squad) => `${squad.name} ${rosterLine(squad)}`.toLowerCase().includes(needle))
    : squads;
  if (shown.length === 0) return null;

  return (
    <section className="squad-picker" aria-label="Squads">
      <div className="node-deck__pane-label"><span>Squads</span></div>
      <PickerCardGrid>
        {shown.map((squad) => (
          <PickerCard
            key={squad.squadId}
            kind="squad"
            art={<SquadPortraitStack squadKey={squad.squadId} squad={squad} />}
            title={squad.name}
            lead={squadSummary(squad)}
            body={rosterLine(squad)}
            label={`Place squad ${squad.name}, ${squadSummary(squad)}`}
            onActivate={() => onPlace(squad.squadId)}
            menu={{
              label: `Manage squad ${squad.name}`,
              title: "Rename or delete",
              onOpen: (anchor) => setManaging({ squad, anchor }),
            }}
          />
        ))}
      </PickerCardGrid>
      {managing ? (
        <PickerCardManage
          key={managing.squad.squadId}
          noun="squad"
          name={managing.squad.name}
          maxLength={SQUAD_NAME_MAX}
          anchor={managing.anchor}
          onClose={() => setManaging(null)}
          onRename={(name) => renameSquad(managing.squad.squadId, name)}
          onDelete={() => deleteSquad(managing.squad.squadId)}
          testId="squad-manage"
        />
      ) : null}
    </section>
  );
}
