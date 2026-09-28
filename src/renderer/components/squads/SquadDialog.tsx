import { useEffect, useMemo, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import { SQUAD_NAME_MAX } from "@shared/squads";
import { claimFocusAndSelectOnMount } from "../../lib/focus-ownership";
import { captureSquad, squadSummary } from "../../lib/squads";
import { squadPortraitOf } from "../../lib/squad-portraits";
import { closeSaveSquad, ensureSquads, saveSquadFromSelection, squadDialog$ } from "../../lib/squads-state";
import { state$ } from "../../lib/state";
import { FocusSurface } from "../FocusSurface";
import { Button, FieldLabel, IconButton, Input, OverlayHeader } from "../ui";
import { SquadPortraitRow } from "./SquadPortraitRow";
import "./squads.css";

/** Mounted once on the canvas; shows the dialog while one is requested. */
export function SquadDialogHost() {
  const request = use$(squadDialog$);
  if (!request) return null;
  return <SquadDialog key={request.selectedIds.join(",")} selectedIds={request.selectedIds} />;
}

/**
 * Save the selected agent seats as a new squad under a name. A save never
 * replaces another squad: a name already in use is refused, and the operator
 * picks another.
 */
function SquadDialog({ selectedIds }: { readonly selectedIds: ReadonlyArray<string> }) {
  // Also starts the soul and instructions store the capture reads.
  useEffect(ensureSquads, []);
  const preview = useMemo(
    () => captureSquad(state$.doc.peek(), selectedIds, { portraitOf: squadPortraitOf }),
    [selectedIds],
  );
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError("give the squad a name");
      return;
    }
    setSaving(true);
    const reason = await saveSquadFromSelection(trimmed, selectedIds);
    setSaving(false);
    if (reason) setError(reason);
    else closeSaveSquad();
  };

  return (
    <FocusSurface measure="form" height="fit" layer="work" label="Save as squad" onClose={closeSaveSquad}>
      <OverlayHeader
        eyebrow="Squad"
        title="Save as squad"
        status={preview ? squadSummary(preview) : "no agent seat selected"}
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
          <Input
            ref={claimFocusAndSelectOnMount}
            value={name}
            maxLength={SQUAD_NAME_MAX}
            onChange={(event) => {
              setName(event.target.value);
              setError("");
            }}
            placeholder="Review squad"
            aria-label="Squad name"
          />
          <small className="squad-dialog__hint">
            Saves a new squad in Add item. Your other squads stay as they are.
          </small>
        </div>

        {error ? <p className="squad-dialog__error" role="alert">{error}</p> : null}

        <div className="squad-dialog__actions">
          <Button variant="subtle" onClick={closeSaveSquad}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!preview || saving}>Save squad</Button>
        </div>
      </form>
    </FocusSurface>
  );
}
