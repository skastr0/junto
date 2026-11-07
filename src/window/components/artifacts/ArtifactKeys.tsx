import { useState } from "react";
import { use$ } from "@legendapp/state/react";
import { Keyboard } from "lucide-react";
import type { ArtifactType } from "@shared/artifact";
import { chordKeyCaps, chordsFor, KEY_TABLE, type KeyOverrides, type ShortcutArea, type ShortcutId } from "@shared/key-table";
import { keyboardSettings } from "@shared/settings";
import { isMac } from "../../lib/platform";
import { state$ } from "../../lib/state";
import { HelpMap, HelpMapGroup, HelpMapKeys, IconButton, Popover, type HelpMapKeyRow } from "../ui";

/** The editor's own keys, by the type in front. A type with none shows the pane's keys only. */
const TYPE_AREA: Partial<Record<ArtifactType, ShortcutArea>> = {
  document: "Inside a document",
  sheet: "Inside a sheet",
  pad: "Inside the drawing pad",
};

/** Shortcuts named elsewhere in the table that an artifact answers too, in its own words. */
const BORROWED: ReadonlyArray<{ readonly id: ShortcutId; readonly does: string }> = [
  { id: "message.send", does: "Send the comment being written" },
];

const rowOf = (id: ShortcutId, does: string, mac: boolean, overrides: KeyOverrides): HelpMapKeyRow | null => {
  const def = KEY_TABLE.find((row) => row.id === id);
  if (def === undefined) return null;
  const caps = def.shown ?? chordsFor(def, mac, overrides).map((chord) => chordKeyCaps(chord, mac));
  if (caps.length === 0) return null;
  return { keys: caps.map((keys) => keys.join(mac ? "" : "+")).join(" - "), action: does };
};

/** The keys for an artifact of this type, from the key table: the pane's, then its editor's. */
export const artifactKeyRows = (
  type: ArtifactType,
  mac: boolean,
  overrides: KeyOverrides = {},
): { readonly pane: HelpMapKeyRow[]; readonly editor: HelpMapKeyRow[] } => {
  const inArea = (area: ShortcutArea | undefined): HelpMapKeyRow[] =>
    area === undefined
      ? []
      : KEY_TABLE.flatMap((def) => {
          if (def.area !== area) return [];
          const row = rowOf(def.id, def.does, mac, overrides);
          return row === null ? [] : [row];
        });
  const borrowed = BORROWED.flatMap(({ id, does }) => {
    const row = rowOf(id, does, mac, overrides);
    return row === null ? [] : [row];
  });
  return { pane: [...inArea("Inside an artifact"), ...inArea("Inside a list"), ...borrowed], editor: inArea(TYPE_AREA[type]) };
};

/** The widest chord here is three caps; the words get the rest of the panel. */
const KEY_WIDTH = "88px";

const EDITOR_LABEL: Partial<Record<ArtifactType, string>> = { document: "document", sheet: "sheet", pad: "pad" };

/** The artifact's keys, one press away in its header. */
export function ArtifactKeys({ type }: { readonly type: ArtifactType }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const overrides = use$(() => keyboardSettings(state$.settings.get()).overrides);
  const { pane, editor } = artifactKeyRows(type, isMac(), overrides);
  return (
    <>
      <IconButton
        aria-label="Keys"
        title="Keys"
        size="sm"
        aria-haspopup="dialog"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(anchor === null ? event.currentTarget : null)}
      >
        <Keyboard size={14} />
      </IconButton>
      {anchor !== null ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} label="Artifact keys" sides={["below", "left"]} width={440}>
          <HelpMap role="group" title="keys" eyebrow="artifact" aria-label="Artifact keys" closeLabel="Close keys" onClose={() => setAnchor(null)}>
            <HelpMapGroup label="pane">
              <HelpMapKeys rows={pane} keyWidth={KEY_WIDTH} />
            </HelpMapGroup>
            {editor.length > 0 ? (
              <HelpMapGroup label={EDITOR_LABEL[type] ?? type}>
                <HelpMapKeys rows={editor} keyWidth={KEY_WIDTH} />
              </HelpMapGroup>
            ) : null}
          </HelpMap>
        </Popover>
      ) : null}
    </>
  );
}
