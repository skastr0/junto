import { createContext, useContext } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { IconButton } from "./IconButton";

/**
 * What a focus modal lets its header do to the window around it. FocusSurface
 * provides it; a surface that cannot grow (a short form) provides nothing, and
 * every control here then renders nothing.
 */
export type FocusWindow = {
  readonly maximized: boolean;
  readonly toggleMaximized: () => void;
};

export const FocusWindowContext = createContext<FocusWindow | null>(null);

export const useFocusWindow = (): FocusWindow | null => useContext(FocusWindowContext);

/**
 * Widen the modal to the full width of its frame, less the surface's own
 * padding, and back. One control for every modal: OverlayHeader places it in
 * its actions, and the sidebar header of a TwoPane modal places it beside the
 * sidebar toggle.
 */
export function FocusMaximizeButton() {
  const focusWindow = useFocusWindow();
  if (focusWindow === null) return null;
  const { maximized, toggleMaximized } = focusWindow;
  // One fixed name and a pressed state; the tooltip says what a press does.
  return (
    <IconButton
      aria-label="Maximize"
      title={maximized ? "Restore size" : "Maximize"}
      size="sm"
      aria-pressed={maximized}
      onClick={toggleMaximized}
    >
      {maximized ? <Minimize2 size={14} aria-hidden /> : <Maximize2 size={14} aria-hidden />}
    </IconButton>
  );
}
