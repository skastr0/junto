import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { ArtifactLabel } from "@shared/artifact-labels";
import { claimFocus } from "../../lib/focus-ownership";
import { ARTIFACT_LABEL_COLOURS, type ArtifactLabelColour, LABEL_COLOUR_NOUN } from "../../lib/artifact-label-colours";
import { MenuItem, Popover } from "../ui";

const CHOICES: ReadonlyArray<ArtifactLabelColour | null> = [null, ...ARTIFACT_LABEL_COLOURS];
const SIDES = ["below", "above"] as const;

/** A colour's swatch: a dot in it, or an empty ring for none. */
export function LabelColourDot({ colour }: { readonly colour: ArtifactLabelColour | null }) {
  return <span className="label-colour-dot" data-label-colour={colour ?? undefined} aria-hidden />;
}

/** Which label's swatch menu is open, and the control that opened it. */
type Colouring = { readonly label: ArtifactLabel; readonly anchor: HTMLElement };

/**
 * The open swatch menu of a set of labels, and its opener's focus: a close
 * by a pick, Escape or Tab gives focus back to the control that opened it,
 * once the menu is gone; a press outside leaves focus where it went.
 */
export const useColourMenu = (): {
  readonly colouring: Colouring | null;
  readonly toggle: (label: ArtifactLabel, anchor: HTMLElement) => void;
  readonly close: (refocus: boolean) => void;
} => {
  const [colouring, setColouring] = useState<Colouring | null>(null);
  const refocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (colouring !== null || refocus.current === null) return;
    const opener = refocus.current;
    refocus.current = null;
    if (opener.isConnected) claimFocus(opener, "gesture");
  }, [colouring]);
  return {
    colouring,
    toggle: (label, anchor) => setColouring((open) => (open?.label === label && open.anchor === anchor ? null : { label, anchor })),
    close: (back) => {
      if (back) refocus.current = colouring?.anchor ?? null;
      setColouring(null);
    },
  };
};

/**
 * The swatch menu on a label (0.11, 03 Colours): No colour and the eight,
 * each named in words, the label's own checked. Opened from the keyboard,
 * focus lands on the checked one; arrows, Home and End move, Enter, Space or
 * a press sets the one there and closes, and Escape or Tab closes. Every one
 * of those gives focus back to the opener; a press outside only closes.
 */
export function LabelColourMenu({
  anchor,
  label,
  colour,
  onPick,
  onClose,
}: {
  readonly anchor: HTMLElement;
  readonly label: ArtifactLabel;
  readonly colour: ArtifactLabelColour | null;
  readonly onPick: (colour: ArtifactLabelColour | null) => void;
  /** `refocus`: give focus back to the opener once the menu is gone. */
  readonly onClose: (refocus: boolean) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const done = useRef(onClose);
  done.current = onClose;
  // A menu closes on Tab and on Escape, and both give focus back to the opener.
  // Heard ahead of the popover's own keys: a layout effect registers before its
  // passive one, and the popover's Tab walk does not fit a roving tab stop.
  useLayoutEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" || (event.key === "Tab" && menu.current?.contains(document.activeElement) === true)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        done.current(true);
      }
    };
    // focus-law: Escape and Tab close the open swatch menu, never a typing shortcut.
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
  const move = (event: KeyboardEvent<HTMLDivElement>): void => {
    const items = [...(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === "ArrowDown"
        ? (at + 1) % items.length
        : event.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    claimFocus(items[to], "gesture", { event: event.nativeEvent });
  };
  return (
    <Popover anchor={anchor} onClose={() => onClose(false)} label={`Colour for ${label}`} sides={SIDES} width={168} className="label-colour-menu">
      <div ref={menu} role="menu" aria-label={`Colour for ${label}`} onKeyDown={move}>
        {CHOICES.map((choice) => {
          const checked = choice === colour;
          return (
            <MenuItem
              key={choice ?? "none"}
              role="menuitemradio"
              aria-checked={checked}
              // The checked one is the menu's one stop, and a keyboard open lands on it.
              tabIndex={checked ? 0 : -1}
              data-autofocus={checked ? "" : undefined}
              onClick={() => {
                onPick(choice);
                onClose(true);
              }}
            >
              <LabelColourDot colour={choice} />
              <span className="label-colour-menu__word">{choice === null ? "No colour" : LABEL_COLOUR_NOUN[choice]}</span>
              {checked ? <Check size={12} aria-hidden className="label-colour-menu__check" /> : null}
            </MenuItem>
          );
        })}
      </div>
    </Popover>
  );
}
