import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { MoreHorizontal } from "lucide-react";
import type { Squad } from "@shared/squads";
import { SQUAD_NAME_MAX } from "@shared/squads";
import { claimFocus } from "../../lib/focus-ownership";
import { squadSeatNodes, squadSummary } from "../../lib/squads";
import {
  deleteSquad,
  ensureSquads,
  openSaveSquad,
  renameSquad,
  squads$,
} from "../../lib/squads-state";
import { state$ } from "../../lib/state";
import { Button, IconButton, Input, Popover } from "../ui";
import { SquadPortraitRow } from "./SquadPortraitRow";
import "./squads.css";

/** Live agent-seat selection, for "update from selection". */
const selectedSeatIds = (): ReadonlyArray<string> => {
  const ids = state$.selectedNodeIds.peek();
  const single = state$.selectedNodeId.peek();
  const all = ids.length > 0 ? ids : single ? [single] : [];
  return squadSeatNodes(state$.doc.peek().nodes, all).map((node) => node.id);
};

/**
 * Squads in the add picker: one card per squad (name, faces, size). A click
 * places it; the card's menu (or a right-click) renames, updates from the
 * current selection, or deletes it. Hidden while there are no squads.
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
  const shown = needle ? squads.filter((squad) => squad.name.toLowerCase().includes(needle)) : squads;
  if (squads.length === 0 || shown.length === 0) return null;

  const manage = (squad: Squad, anchor: HTMLElement) => setManaging({ squad, anchor });

  return (
    <section className="squad-picker" aria-label="Squads">
      <div className="node-deck__pane-label"><span>Squads</span></div>
      <ul className="squad-picker__list">
        {shown.map((squad) => (
          <li key={squad.squadId} className="squad-picker__item">
            <button
              type="button"
              className="squad-picker__card"
              aria-label={`Place squad ${squad.name}, ${squadSummary(squad)}`}
              title={squad.prompt ? `Opening prompt: ${squad.prompt}` : undefined}
              onClick={() => onPlace(squad.squadId)}
              onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => {
                event.preventDefault();
                event.stopPropagation();
                manage(squad, event.currentTarget);
              }}
            >
              <SquadPortraitRow squadKey={squad.squadId} squad={squad} />
              <span className="squad-picker__name">{squad.name}</span>
              <small className="squad-picker__meta">{squadSummary(squad)}</small>
            </button>
            <IconButton
              aria-label={`Manage squad ${squad.name}`}
              title="Rename, update, or delete"
              className="squad-picker__more"
              onClick={(event) => manage(squad, event.currentTarget)}
            >
              <MoreHorizontal size={13} />
            </IconButton>
          </li>
        ))}
      </ul>
      {managing ? (
        <SquadManagePopover
          key={managing.squad.squadId}
          squad={managing.squad}
          anchor={managing.anchor}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </section>
  );
}

function SquadManagePopover({
  squad,
  anchor,
  onClose,
}: {
  readonly squad: Squad;
  readonly anchor: HTMLElement;
  readonly onClose: () => void;
}) {
  const [name, setName] = useState(squad.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const seats = selectedSeatIds();

  useEffect(() => {
    claimFocus(inputRef.current, "open", { select: true });
  }, []);

  const rename = async (): Promise<void> => {
    if (name.trim() === squad.name) return onClose();
    const reason = await renameSquad(squad.squadId, name);
    if (reason) setError(reason);
    else onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Manage squad ${squad.name}`} width={288} testId="squad-manage">
      <form
        className="squad-manage"
        onSubmit={(event) => {
          event.preventDefault();
          void rename();
        }}
      >
        <Input
          ref={inputRef}
          value={name}
          maxLength={SQUAD_NAME_MAX}
          onChange={(event) => {
            setName(event.target.value);
            setError("");
          }}
          aria-label="Squad name"
        />
        <div className="squad-manage__row">
          <Button size="xs" type="submit" disabled={!name.trim()}>Rename</Button>
          <Button
            size="xs"
            disabled={seats.length === 0}
            title={seats.length === 0 ? "Select agent seats on the canvas first" : undefined}
            onClick={() => {
              onClose();
              openSaveSquad(seats, squad.squadId);
            }}
          >
            Update from selection
          </Button>
        </div>
        <div className="squad-manage__row">
          {confirmDelete ? (
            <>
              <Button
                size="xs"
                variant="danger"
                onClick={() => {
                  void deleteSquad(squad.squadId).then((reason) => (reason ? setError(reason) : onClose()));
                }}
              >
                Delete {squad.name}
              </Button>
              <Button size="xs" variant="subtle" onClick={() => setConfirmDelete(false)}>Keep</Button>
            </>
          ) : (
            <Button size="xs" variant="subtle" onClick={() => setConfirmDelete(true)}>Delete squad</Button>
          )}
        </div>
        {error ? <p className="squad-dialog__error" role="alert">{error}</p> : null}
      </form>
    </Popover>
  );
}
