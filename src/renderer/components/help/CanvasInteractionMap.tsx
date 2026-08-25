import { HERDR_ENABLED } from "@shared/features";
import {
  HelpMap,
  HelpMapGroup,
  HelpMapKeys,
  HelpMapPrimer,
  HelpMapPrimerBlock,
  type HelpMapKeyRow,
} from "../ui";

/** Canvas pointer / gesture inventory — single source for the interaction map. */
export const CANVAS_HELP_POINTER: ReadonlyArray<HelpMapKeyRow> = [
  { keys: "scroll", action: "pan the field" },
  { keys: "mid-drag", action: "pan the field" },
  { keys: "drag empty", action: "rubber-band multi-select (works inside regions)" },
  { keys: "⇧ click", action: "multi-select (dominates labels & chrome)" },
  { keys: "multi selection", action: "RTS bar - bulk color/flags - same-kind multi-prompt" },
  { keys: "⌘↵ multi-prompt", action: "send one prompt to all selected agents" },
  { keys: "double-click", action: "add a note at cursor" },
  { keys: "right-click empty", action: "add item menu (place at cursor)" },
  { keys: "right-click region", action: "add item inside the region" },
  { keys: "drag card", action: "move a node" },
  { keys: "region frame / title bar", action: "select - move region (body is for marquee)" },
  { keys: "double-click region name", action: "rename the region" },
  { keys: "select + corners", action: "resize a node" },
  { keys: "drag edge handle", action: "connect nodes (drop on a card)" },
  { keys: "click edge", action: "open the wire's settings" },
  { keys: "click node", action: "select - open command card" },
  { keys: "RMB selection", action: "bulk: region - flags - delete" },
  { keys: "select + RMB target", action: "connect all → that node" },
  { keys: "⇧ RMB target", action: "connect keep selection (fan-out)" },
  { keys: "⌥ / Alt + move", action: "scan nearby nodes at readable scale" },
  { keys: "minimap click", action: "jump camera - dbl-click zoom" },
  { keys: "add item - fit all", action: "docked above minimap" },
];

/** Canvas hotkey inventory — single source for the interaction map. */
export const CANVAS_HELP_KEYS: ReadonlyArray<HelpMapKeyRow> = [
  { keys: "⌘K - /", action: "open command bar (jump to a node)" },
  { keys: "Escape", action: "close overlays / clear selection" },
  { keys: "⌘Z - ⌘⇧Z", action: "undo - redo" },
  { keys: "⌫ - Del", action: "delete multi or single selection" },
  { keys: "1–9", action: "focus hotbar slot - re-tap (~1s) cycles region members + opens actor model" },
  { keys: "⌘1–9", action: "assign selected node → slot (any node)" },
  { keys: "Space - `", action: "cycle notifications → ready → working (all canvas seats)" },
  { keys: "double-click actor", action: "open managed terminal (agent model)" },
  ...(HERDR_ENABLED
    ? ([{ keys: "F1 - .", action: "cycle idle herdr workers needing you" }] as const)
    : []),
];

/**
 * Full canvas interaction map — dock under the station bar help trigger.
 * Reuse {@link HelpMap} pieces elsewhere; this is the canvas-shaped fill.
 */
export function CanvasInteractionMap({ onClose }: { readonly onClose: () => void }) {
  return (
    <HelpMap
      className="help-map--dock-top-right"
      eyebrow="canvas"
      title="interaction map"
      aria-label="Interaction help"
      closeLabel="Close interaction help"
      onClose={onClose}
    >
      <HelpMapGroup label="how the canvas works" aria-label="How the canvas works">
        <HelpMapPrimer>
          <HelpMapPrimerBlock lead="wires">
            a wire is permission. What a node can do to another travels only
            over a drawn wire, and each wire lists exactly what it allows.
          </HelpMapPrimerBlock>
          <HelpMapPrimerBlock lead="waiting">
            an agent pauses only while its own task or question waits on you.
            Nothing else on the canvas stops it, and selecting a node never
            changes what it can do.
          </HelpMapPrimerBlock>
        </HelpMapPrimer>
      </HelpMapGroup>
      <HelpMapGroup label="pointer">
        <HelpMapKeys rows={CANVAS_HELP_POINTER} />
      </HelpMapGroup>
      <HelpMapGroup label="keys">
        <HelpMapKeys rows={CANVAS_HELP_KEYS} />
      </HelpMapGroup>
    </HelpMap>
  );
}
