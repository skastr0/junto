import { useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import type { Squad } from "@shared/squads";
import { SQUAD_NAME_MAX, SQUAD_PROMPT_MAX } from "@shared/squads";
import { claimFocus } from "../../lib/focus-ownership";
import { captureSquad, squadSeatNodes, squadSummary } from "../../lib/squads";
import { squadPortraitOf } from "../../lib/squad-portraits";
import {
  closeSaveSquad,
  ensureSquads,
  saveSquadFromSelection,
  squadDialog$,
  squads$,
} from "../../lib/squads-state";
import { state$ } from "../../lib/state";
import { nodeTitle } from "../../lib/presentation";
import { FocusSurface } from "../FocusSurface";
import { AgentPortrait } from "../AgentPortrait";
import { Button, Combobox, FieldLabel, IconButton, Input, OverlayHeader } from "../ui";
import { Textarea } from "../ui/Field";
import { SquadPortraitRow } from "./SquadPortraitRow";
import "./squads.css";

const sameName = (a: string, b: string): boolean =>
  a.trim().localeCompare(b.trim(), undefined, { sensitivity: "base" }) === 0;

/** Mounted once on the canvas; shows the dialog while one is requested. */
export function SquadDialogHost() {
  const request = use$(squadDialog$);
  if (!request) return null;
  return (
    <SquadDialog
      key={`${request.squadId ?? "new"}|${request.selectedIds.join(",")}`}
      selectedIds={request.selectedIds}
      {...(request.squadId ? { replaceId: request.squadId } : {})}
    />
  );
}

/**
 * Save the selected agent seats as a squad: a name (typing an existing one,
 * or picking it, replaces that squad), an optional opening prompt for the
 * squad, and optional prompts per seat.
 */
function SquadDialog({
  selectedIds,
  replaceId,
}: {
  readonly selectedIds: ReadonlyArray<string>;
  readonly replaceId?: string;
}) {
  useEffect(ensureSquads, []);
  const squads = use$(squads$.list);
  const doc = state$.doc.peek();
  const seats = useMemo(() => squadSeatNodes(doc.nodes, selectedIds), [doc, selectedIds]);
  const preview = useMemo(
    () => captureSquad(doc, selectedIds, { portraitOf: squadPortraitOf }),
    [doc, selectedIds],
  );
  const replacing = squads.find((squad) => squad.squadId === replaceId);
  const [name, setName] = useState(replacing?.name ?? "");
  const [prompt, setPrompt] = useState(replacing?.prompt ?? "");
  const [seatPrompts, setSeatPrompts] = useState<Record<string, string>>({});
  const [perSeat, setPerSeat] = useState(false);
  const [active, setActive] = useState<string | undefined>(undefined);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  const target = squads.find((squad) => sameName(squad.name, name));
  const matches = squads.filter((squad) =>
    name.trim() === "" ? true : squad.name.toLowerCase().includes(name.trim().toLowerCase()),
  );
  const completion = name.trim()
    ? squads.find((squad) => squad.name.toLowerCase().startsWith(name.toLowerCase()))?.name
    : undefined;

  const choose = (squad: Squad): void => {
    setName(squad.name);
    if (!prompt.trim() && squad.prompt) setPrompt(squad.prompt);
    claimFocus(promptRef.current, "gesture");
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("give the squad a name");
      return;
    }
    setSaving(true);
    const reason = await saveSquadFromSelection({
      name: trimmed,
      selectedIds,
      ...(target ? { squadId: target.squadId } : {}),
      prompt,
      seatPrompts,
    });
    setSaving(false);
    if (reason) setError(reason);
    else closeSaveSquad();
  };

  const status = preview ? squadSummary(preview) : "no agent seat selected";

  return (
    <FocusSurface measure="form" height="fit" layer="work" label="Save as squad" onClose={closeSaveSquad}>
      <OverlayHeader
        eyebrow="Squad"
        title={target ? `Replace ${target.name}` : "Save as squad"}
        status={status}
        actions={
          <IconButton aria-label="Close save as squad" title="Close" onClick={closeSaveSquad}>
            <X size={14} />
          </IconButton>
        }
      />
      <form
        className="squad-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {preview ? <SquadPortraitRow squadKey="draft" squad={preview} size={28} /> : null}

        <div className="squad-dialog__field">
          <FieldLabel>Name</FieldLabel>
          <Combobox<Squad>
            value={name}
            onValueChange={(value) => {
              setName(value.slice(0, SQUAD_NAME_MAX));
              setError("");
            }}
            {...(completion ? { completion } : {})}
            options={matches}
            optionKey={(squad) => squad.squadId}
            renderOption={(squad) => (
              <span className="squad-dialog__option">
                <SquadPortraitRow squadKey={squad.squadId} squad={squad} size={16} />
                <span className="squad-dialog__option-name">{squad.name}</span>
                <small>{squadSummary(squad)}, replace</small>
              </span>
            )}
            activeKey={active}
            onActiveKeyChange={setActive}
            {...(target ? { selectedKey: target.squadId } : {})}
            onCommit={(option, value) => {
              if (option) choose(option);
              else {
                setName(value);
                void save();
              }
            }}
            onOptionClick={choose}
            aria-label="Squad name"
            listLabel="Existing squads"
            placeholder="Review squad"
            empty={<span className="squad-dialog__hint">No squads yet. This one is the first.</span>}
          />
          <small className="squad-dialog__hint">
            {target ? `Saving replaces ${target.name}.` : "Pick an existing squad to replace it."}
          </small>
        </div>

        <div className="squad-dialog__field">
          <FieldLabel>Opening prompt (optional)</FieldLabel>
          <Textarea
            ref={promptRef}
            value={prompt}
            maxLength={SQUAD_PROMPT_MAX}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Sent to every seat when the squad is placed."
            aria-label="Opening prompt for the squad"
          />
        </div>

        <div className="squad-dialog__field">
          <Button
            variant="subtle"
            size="xs"
            aria-expanded={perSeat}
            onClick={() => setPerSeat(!perSeat)}
          >
            {perSeat ? "Hide seat prompts" : "Prompt each seat"}
          </Button>
          {perSeat ? (
            <ul className="squad-dialog__seats" aria-label="Opening prompt per seat">
              {seats.map((node) => (
                <li key={node.id}>
                  <AgentPortrait
                    identity={node.id}
                    size={20}
                    frame="round"
                    badge={false}
                    outline={false}
                    harness={node.ether?.terminal?.harness}
                  />
                  <Input
                    value={seatPrompts[node.id] ?? ""}
                    maxLength={SQUAD_PROMPT_MAX}
                    onChange={(event) => setSeatPrompts({ ...seatPrompts, [node.id]: event.target.value })}
                    placeholder={`${nodeTitle(node)}: uses the squad prompt`}
                    aria-label={`Opening prompt for ${nodeTitle(node)}`}
                  />
                </li>
              ))}
            </ul>
          ) : null}
        </div>

        {error ? <p className="squad-dialog__error" role="alert">{error}</p> : null}

        <div className="squad-dialog__actions">
          <Button variant="subtle" onClick={closeSaveSquad}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!preview || saving}>
            {target ? "Replace squad" : "Save squad"}
          </Button>
        </div>
      </form>
    </FocusSurface>
  );
}
