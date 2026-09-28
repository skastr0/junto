import { useEffect, useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import {
  CANVAS_SWATCHES,
  canvasSwatchFor,
  normalizeHexColor,
  rememberCustomColor,
} from "@shared/canvas-colors";
import { Popover } from "../ui/Popover";
import { Button } from "../ui/Button";
import { Input } from "../ui/Field";
import { setNodeColor, setNodeColorForNodes } from "../../lib/mutations";
import { patchSettings } from "../../lib/settings-state";
import { state$ } from "../../lib/state";
import { claimFocus } from "../../lib/focus-ownership";
import { HUE, accentColor } from "../../lib/theme";
import "./AccentColorPicker.css";

/**
 * Card and region colour: the JSON Canvas presets and the named palette in
 * hue order (shared/canvas-colors.ts), then "+" for any colour by hex. A node
 * wearing a custom colour shows it on the "+" dot, lit.
 */
export function AccentColorSwatches({
  nodeId,
  nodeIds,
  color,
  mixed = false,
}: {
  readonly nodeId?: string;
  /** When set, applies color to every id (multi-select). */
  readonly nodeIds?: ReadonlyArray<string>;
  readonly color: string | undefined;
  /** Selection has differing colors — no swatch pretends to be the active one. */
  readonly mixed?: boolean;
}) {
  const [customAnchor, setCustomAnchor] = useState<HTMLElement | null>(null);
  const apply = (next: string | undefined) => {
    setCustomAnchor(null);
    if (nodeIds && nodeIds.length > 0) {
      setNodeColorForNodes(nodeIds, next);
      return;
    }
    if (nodeId) setNodeColor(nodeId, next);
  };
  const current = mixed ? undefined : color;
  const active = canvasSwatchFor(current);
  const custom = current && !active ? normalizeHexColor(current) : undefined;
  const defaultActive = !mixed && !color;
  return (
    <div
      className="rts-cmd-accents"
      role="group"
      aria-label="Colour"
      title={mixed ? "Mixed colours — pick one to apply to all" : undefined}
    >
      <button
        type="button"
        className={`rts-swatch${defaultActive ? " is-active" : ""}`}
        title={mixed ? "Set all to the default colour" : "Default colour"}
        aria-label="Use the default colour"
        aria-pressed={defaultActive}
        onClick={() => apply(undefined)}
      >
        <span style={{ background: HUE.amber }} />
      </button>
      {CANVAS_SWATCHES.map(({ value, label }) => {
        const on = active?.value === value;
        return (
          <button
            key={value}
            type="button"
            className={`rts-swatch${on ? " is-active" : ""}`}
            title={mixed ? `Set all to ${label}` : label}
            aria-label={`Set ${label}`}
            aria-pressed={on}
            onClick={() => apply(value)}
          >
            <span style={{ background: accentColor(value) }} />
          </button>
        );
      })}
      <button
        type="button"
        className={`rts-swatch rts-swatch--custom${custom ? " is-active" : ""}`}
        title={custom ? `Custom ${custom}` : "Custom colour"}
        aria-label={custom ? `Custom colour ${custom}, change it` : "Choose a custom colour"}
        aria-pressed={Boolean(custom)}
        aria-expanded={customAnchor !== null}
        aria-haspopup="dialog"
        onClick={(event) => {
          // Anchored to the whole palette, so the popover sits clear of both rows.
          const anchor = event.currentTarget.parentElement;
          setCustomAnchor((open) => (open ? null : anchor));
        }}
      >
        {custom ? <span style={{ background: custom }} /> : <Plus size={9} strokeWidth={2.4} aria-hidden />}
      </button>
      {customAnchor ? (
        <CustomColorPopover
          anchor={customAnchor}
          initial={custom}
          onClose={() => setCustomAnchor(null)}
          onApply={apply}
        />
      ) : null}
    </div>
  );
}

function CustomColorPopover({
  anchor,
  initial,
  onClose,
  onApply,
}: {
  readonly anchor: HTMLElement;
  readonly initial: string | undefined;
  readonly onClose: () => void;
  readonly onApply: (hex: string) => void;
}) {
  const recent = use$(state$.settings).appearance.recentColors ?? [];
  const [draft, setDraft] = useState(initial ?? recent[0] ?? "");
  const [refused, setRefused] = useState(false);
  const hex = normalizeHexColor(draft);
  const palette = hex ? canvasSwatchFor(hex) : undefined;
  const hexRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    // The popover mounts hidden until it is placed, and a hidden field cannot
    // take focus; claim it on the next frame, once it shows.
    const frame = requestAnimationFrame(() => claimFocus(hexRef.current, "open", { select: true }));
    return () => cancelAnimationFrame(frame);
  }, []);

  const choose = (next: string) => {
    // A palette colour keeps its swatch (and its bright-mode shade); only a
    // colour the palette lacks joins the recent list.
    if (!canvasSwatchFor(next) && recent[0] !== next) {
      void patchSettings({ appearance: { recentColors: rememberCustomColor(recent, next) } });
    }
    onApply(palette ? palette.value : next);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!hex) {
      setRefused(true);
      return;
    }
    choose(hex);
  };

  return (
    <Popover anchor={anchor} onClose={onClose} label="Custom colour" sides={["above", "below", "right", "left"]} align="center" width={216} className="accent-custom">
      <form className="accent-custom__form" onSubmit={submit} noValidate>
        <label className="accent-custom__label" htmlFor="accent-custom-hex">
          Custom colour
        </label>
        <div className="accent-custom__row">
          <input
            type="color"
            className="accent-custom__well"
            aria-label="Pick from the colour picker"
            value={hex ?? "#e8a33d"}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setRefused(false);
            }}
          />
          <Input
            id="accent-custom-hex"
            ref={hexRef}
            className="accent-custom__hex"
            value={draft}
            placeholder="#f5c400"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={refused && !hex}
            aria-describedby={refused && !hex ? "accent-custom-error" : undefined}
            onChange={(event) => {
              setDraft(event.currentTarget.value);
              setRefused(false);
            }}
          />
          <Button type="submit" variant="primary">
            Use
          </Button>
        </div>
        {refused && !hex ? (
          <p id="accent-custom-error" className="accent-custom__error">
            Use 3 or 6 hex digits, like #f5c400.
          </p>
        ) : palette ? (
          <p className="accent-custom__note">That is {palette.label} from the palette.</p>
        ) : null}
        {recent.length > 0 ? (
          <div className="accent-custom__recent" role="group" aria-label="Recent custom colours">
            <span className="accent-custom__label">Recent</span>
            <div className="accent-custom__dots">
              {recent.map((value) => (
                <button
                  key={value}
                  type="button"
                  className={`rts-swatch${value === initial ? " is-active" : ""}`}
                  title={value}
                  aria-label={`Use ${value}`}
                  aria-pressed={value === initial}
                  onClick={() => choose(value)}
                >
                  <span style={{ background: value }} />
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </form>
    </Popover>
  );
}
