import { useRef, type KeyboardEvent } from "react";
import { Check } from "lucide-react";
import type { ArtifactLabel } from "@shared/artifact-labels";
import { claimFocus } from "../../lib/focus-ownership";
import { ARTIFACT_LABEL_COLOURS, type ArtifactLabelColour, LABEL_COLOUR_NOUN } from "../../lib/artifact-label-colours";
import { Popover } from "../ui";

const CHOICES: ReadonlyArray<ArtifactLabelColour | null> = [null, ...ARTIFACT_LABEL_COLOURS];
const SIDES = ["below", "above"] as const;

/** A colour's swatch: a dot in it, or an empty ring for none. */
export function LabelColourDot({ colour }: { readonly colour: ArtifactLabelColour | null }) {
  return <span className="label-colour-dot" data-label-colour={colour ?? undefined} aria-hidden />;
}

/**
 * The swatch menu on a label (0.11, 03 Colours): No colour and the eight,
 * each named in words, the label's own checked. Arrows, Home and End move
 * through it, Enter, Space or a press sets the one there and closes, and
 * Escape closes as the popover does, the keyboard going back to the opener.
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
  readonly onClose: () => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
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
    <Popover anchor={anchor} onClose={onClose} label={`Colour for ${label}`} sides={SIDES} width={168} className="label-colour-menu">
      <div ref={menu} role="menu" aria-label={`Colour for ${label}`} onKeyDown={move}>
        {CHOICES.map((choice) => {
          const checked = choice === colour;
          return (
            <button
              key={choice ?? "none"}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              // The checked one is the menu's one stop, so the keyboard lands on it.
              tabIndex={checked ? 0 : -1}
              className="label-colour-menu__item"
              onClick={() => {
                onPick(choice);
                onClose();
              }}
            >
              <LabelColourDot colour={choice} />
              <span className="label-colour-menu__word">{choice === null ? "No colour" : LABEL_COLOUR_NOUN[choice]}</span>
              {checked ? <Check size={12} aria-hidden className="label-colour-menu__check" /> : null}
            </button>
          );
        })}
      </div>
    </Popover>
  );
}
