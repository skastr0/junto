import {
  Button,
  HelpMap,
  HelpMapGroup,
  HelpMapKeys,
  type HelpMapKeyRow,
} from "../ui";
import { use$ } from "@legendapp/state/react";
import { KEY_TABLE, chordKeyCaps, chordsFor, type KeyOverrides } from "@shared/key-table";
import { keyboardSettings } from "@shared/settings";
import { openIntro } from "../../lib/first-run-intro";
import { isMac } from "../../lib/platform";
import { state$ } from "../../lib/state";

/** Canvas pointer / gesture inventory — single source for the interaction map. */
export const CANVAS_HELP_POINTER: ReadonlyArray<HelpMapKeyRow> = [
  { keys: "scroll", action: "pan the field" },
  { keys: "mid-drag", action: "pan the field" },
  { keys: "drag empty", action: "rubber-band multi-select (works inside regions)" },
  { keys: "⇧ click", action: "multi-select (dominates labels & chrome)" },
  { keys: "multi selection", action: "RTS bar - bulk color - same-kind multi-prompt" },
  { keys: "⌘↵ multi-prompt", action: "send one prompt to all selected agents" },
  { keys: "double-click", action: "add a note at cursor" },
  { keys: "right-click empty", action: "add item menu (place at cursor)" },
  { keys: "right-click region", action: "add item inside the region" },
  { keys: "drag card", action: "move a node" },
  { keys: "region frame / title bar", action: "select - move region (body is for marquee)" },
  { keys: "double-click region name", action: "rename the region" },
  { keys: "select + corners", action: "resize a node" },
  { keys: "drag edge handle", action: "connect nodes (drop on a card)" },
  { keys: "click edge", action: "select the connection" },
  { keys: "click node", action: "select - open command card" },
  { keys: "RMB selection", action: "bulk: region - squad - delete" },
  { keys: "select + RMB target", action: "connect all → that node" },
  { keys: "⇧ RMB target", action: "connect keep selection (fan-out)" },
  { keys: "⌥ / Alt + move", action: "scan nearby nodes at readable scale" },
  { keys: "minimap click", action: "jump camera - dbl-click zoom" },
  { keys: "add item - fit all", action: "docked above minimap" },
];

/**
 * The keys group: every shortcut in the key table with the chords in use
 * now, the operator's own included, then the canvas's own keys. The keys
 * inside the switcher and inside other screens are left to those screens.
 */
export const shortcutHelpRows = (mac: boolean, overrides: KeyOverrides = {}): HelpMapKeyRow[] =>
  KEY_TABLE.flatMap((def) => {
    if (def.fixed !== undefined && !(def.surface && def.area === "Canvas")) return [];
    const caps = def.shown ?? chordsFor(def, mac, overrides).map((chord) => chordKeyCaps(chord, mac));
    if (caps.length === 0) return [];
    return [{ keys: caps.map((keys) => keys.join(mac ? "" : "+")).join(" - "), action: def.does }];
  });

/**
 * Full canvas interaction map, shown in the station bar's help popover.
 * Reuse {@link HelpMap} pieces elsewhere; this is the canvas-shaped fill.
 */
export function CanvasInteractionMap({ onClose }: { readonly onClose: () => void }) {
  const overrides = use$(() => keyboardSettings(state$.settings.get()).overrides);
  return (
    <HelpMap
      role="group"
      eyebrow="canvas"
      title="interaction map"
      aria-label="Interaction help"
      closeLabel="Close interaction help"
      onClose={onClose}
    >
      <HelpMapGroup label="new here" aria-label="Introduction">
        <div className="help-map__intro">
          <span>What Junto is, how to start an agent, and why macOS may name Junto.</span>
          <Button
            size="sm"
            onClick={() => {
              onClose();
              openIntro();
            }}
          >
            show the introduction
          </Button>
        </div>
      </HelpMapGroup>
      <HelpMapGroup label="pointer">
        <HelpMapKeys rows={CANVAS_HELP_POINTER} />
      </HelpMapGroup>
      <HelpMapGroup label="keys">
        <HelpMapKeys rows={shortcutHelpRows(isMac(), overrides)} />
      </HelpMapGroup>
    </HelpMap>
  );
}
