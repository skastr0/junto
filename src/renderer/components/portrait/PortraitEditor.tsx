import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PORTRAIT_OPTIONS,
  defaultTemperament,
  portraitCharacter,
  type PortraitConfig,
} from "@shared/agent-portrait";
import { portraitExpression, type ExpressionInput, type PortraitExpression } from "@shared/portrait-expression";
import { savePortraitOverride } from "../../lib/portrait-overrides-state";
import { AgentPortrait, usePortraitConfig } from "../AgentPortrait";
import { Button, Eyebrow, Popover } from "../ui";
import "./PortraitEditor.css";

// Character editor: the seat's portrait with live preview. Every option is
// shown as a thumbnail of this character wearing it, so the grid is the
// preview. Edits save as they happen (debounced), so the seat on the canvas
// changes with the editor; Reset drops the override back to identity.

type Trait = keyof typeof PORTRAIT_OPTIONS;

const TRAITS: ReadonlyArray<readonly [Trait, string]> = [
  ["bodyHue", "color"],
  ["shape", "body"],
  ["topper", "ears and toppers"],
  ["accessory", "hats and props"],
  ["eyes", "eyes"],
  ["brows", "brows"],
  ["mouth", "mouth"],
  ["marking", "pattern"],
  ["accentHue", "accent"],
];

// A few seat states to show how temperament reads them.
const MOOD_STRIP: ReadonlyArray<readonly [string, Omit<ExpressionInput, "temperament">]> = [
  ["idle", { activity: "rest" }],
  ["working", { activity: "work" }],
  ["going well", { activity: "work", health: "succeeding" }],
  ["wants you", { activity: "call" }],
  ["stuck", { activity: "work", health: "stuck" }],
  ["done", { activity: "done" }],
];

const SAVE_DEBOUNCE_MS = 220;

const temperamentWord = (value: number): string =>
  value <= -0.34 ? "moody" : value >= 0.34 ? "cheerful" : "even";

const randomConfig = (): PortraitConfig => {
  const any = <T,>(items: ReadonlyArray<T>): T => items[Math.floor(Math.random() * items.length)] as T;
  return {
    bodyHue: any(PORTRAIT_OPTIONS.bodyHue),
    accentHue: any(PORTRAIT_OPTIONS.accentHue),
    shape: any(PORTRAIT_OPTIONS.shape),
    topper: any(PORTRAIT_OPTIONS.topper),
    eyes: any(PORTRAIT_OPTIONS.eyes),
    mouth: any(PORTRAIT_OPTIONS.mouth),
    brows: any(PORTRAIT_OPTIONS.brows),
    marking: any(PORTRAIT_OPTIONS.marking),
    accessory: any(PORTRAIT_OPTIONS.accessory),
    blush: Math.random() < 0.6,
    temperament: Math.round((Math.random() * 2 - 1) * 100) / 100,
  };
};

const isEmpty = (config: PortraitConfig): boolean =>
  Object.values(config).every((value) => value === undefined);

export function PortraitEditor({
  identity,
  name,
  harness,
  anchor,
  onClose,
}: {
  readonly identity: string;
  readonly name: string;
  readonly harness?: string;
  readonly anchor: HTMLElement;
  readonly onClose: () => void;
}) {
  const saved = usePortraitConfig(identity);
  const [draft, setDraft] = useState<PortraitConfig>(saved ?? {});
  const [saveFailed, setSaveFailed] = useState(false);
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const persist = (next: PortraitConfig): void => {
    setDraft(next);
    if (pending.current) clearTimeout(pending.current);
    pending.current = setTimeout(() => {
      void savePortraitOverride(identity, isEmpty(next) ? null : next).then((ok) => setSaveFailed(!ok));
    }, SAVE_DEBOUNCE_MS);
  };
  useEffect(() => () => pending.current && clearTimeout(pending.current), []);

  const character = portraitCharacter(identity, draft);
  const set = <K extends keyof PortraitConfig>(key: K, value: PortraitConfig[K]): void =>
    persist({ ...draft, [key]: value });

  const faceFor = (mood: Omit<ExpressionInput, "temperament">): PortraitExpression =>
    portraitExpression({ ...mood, temperament: character.temperament });

  return (
    <Popover anchor={anchor} onClose={onClose} label={`Customize ${name}`} width={452} testId="portrait-editor">
      <div className="portrait-editor">
        <div className="portrait-editor__hero">
          <AgentPortrait identity={identity} size={96} frame="round" config={draft} harness={harness} />
          <div className="portrait-editor__hero-side">
            <Eyebrow tone="steel">character</Eyebrow>
            <div className="portrait-editor__name">{name}</div>
            <label className="portrait-editor__temperament">
              <span className="portrait-editor__temperament-head">
                <span>temperament</span>
                <span className="text-ink">{temperamentWord(character.temperament)}</span>
              </span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={character.temperament}
                aria-label="Temperament, moody to cheerful"
                onChange={(event) => set("temperament", Number(event.target.value))}
              />
              <span className="portrait-editor__temperament-ends">
                <span>moody</span>
                <span>cheerful</span>
              </span>
            </label>
            <div className="portrait-editor__actions">
              <Button size="xs" variant="chrome" onClick={() => persist(randomConfig())}>
                Randomize
              </Button>
              <Button
                size="xs"
                variant="subtle"
                disabled={isEmpty(draft)}
                title={`Back to the portrait ${name} was born with`}
                onClick={() => persist({})}
              >
                Reset
              </Button>
            </div>
          </div>
        </div>

        <div className="portrait-editor__moods" aria-label="How this character reads seat states">
          {MOOD_STRIP.map(([label, mood]) => (
            <figure key={label}>
              <AgentPortrait identity={identity} size={36} frame="round" config={draft} expression={faceFor(mood)} />
              <figcaption>{label}</figcaption>
            </figure>
          ))}
        </div>

        {TRAITS.map(([trait, label]) => (
          <section key={trait} className="portrait-editor__trait">
            <Eyebrow tone="steel" size="xs">
              {label}
            </Eyebrow>
            <div className="portrait-editor__grid" role="radiogroup" aria-label={label}>
              {PORTRAIT_OPTIONS[trait].map((option) => {
                const active = character[trait] === option;
                return (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    aria-label={`${label} ${option}`}
                    title={option}
                    className="portrait-editor__option"
                    data-active={active ? "true" : undefined}
                    onClick={() => set(trait, option as never)}
                  >
                    <AgentPortrait identity={identity} size={40} frame="round" config={{ ...draft, [trait]: option }} />
                  </button>
                );
              })}
            </div>
          </section>
        ))}

        <label className="portrait-editor__toggle">
          <input type="checkbox" checked={character.blush} onChange={(event) => set("blush", event.target.checked)} />
          <span>rosy cheeks</span>
        </label>
        {saveFailed ? <div className="portrait-editor__error">Could not save this portrait.</div> : null}
        <div className="portrait-editor__foot">
          Born {temperamentWord(defaultTemperament(identity))}. Customization is kept on this install.
        </div>
      </div>
    </Popover>
  );
}

/**
 * Makes a portrait (or a ringed seat) a button that opens the character
 * editor. The wrapped portrait stays presentational; this owns the press.
 */
export function PortraitEditButton({
  identity,
  name,
  harness,
  size = 36,
  children,
}: {
  readonly identity: string;
  readonly name: string;
  readonly harness?: string;
  /** Portrait size when no children are given. */
  readonly size?: number;
  /** What to show as the trigger, e.g. a SeatRing. Defaults to the portrait. */
  readonly children?: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        className="portrait-edit-button"
        aria-label={`Customize ${name}'s portrait`}
        aria-expanded={anchor !== null}
        title="Customize portrait"
        data-testid="portrait-edit-button"
        onClick={(event) => setAnchor(anchor ? null : event.currentTarget)}
      >
        {children ?? <AgentPortrait identity={identity} size={size} frame="round" harness={harness} />}
      </button>
      {anchor ? (
        <PortraitEditor identity={identity} name={name} harness={harness} anchor={anchor} onClose={() => setAnchor(null)} />
      ) : null}
    </>
  );
}
