import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  PORTRAIT_COSMETIC_TRAITS,
  portraitOptions,
  defaultTemperament,
  portraitCharacter,
  type PortraitConfig,
} from "@shared/agent-portrait";
import { cosmeticEntries, type CosmeticEntry } from "@shared/cosmetics/catalog";
import { portraitExpression, type ExpressionInput, type PortraitExpression } from "@shared/portrait-expression";
import "../../lib/cosmetics";
import { savePortraitOverride } from "../../lib/portrait-overrides-state";
import { hasStore, openStore } from "../../overlay/surfaces";
import { AgentPortrait, usePortraitConfig } from "../AgentPortrait";
import { Button, Eyebrow, Popover } from "../ui";
import "./PortraitEditor.css";

// Character editor: the seat's portrait with live preview. Every option is
// shown as a thumbnail of this character wearing it, so the grid is the
// preview. Edits save as they happen (debounced), so the seat on the canvas
// changes with the editor; Reset drops the override back to identity.
// Species, toppers, props, patterns, and colors come from the cosmetic
// catalog, grouped by pack: the base cast first, then each pack this build
// bundled. An item this install may not wear is shown locked and offers the
// store when the build has one; it never renders on a seat.

type Trait = keyof ReturnType<typeof portraitOptions>;

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

type CosmeticTrait = keyof typeof PORTRAIT_COSMETIC_TRAITS;
const isCosmeticTrait = (trait: Trait): trait is CosmeticTrait => trait in PORTRAIT_COSMETIC_TRAITS;

/** Available keys for a cosmetic trait: what Randomize may pick. */
const wearable = (trait: CosmeticTrait): ReadonlyArray<string> =>
  cosmeticEntries(PORTRAIT_COSMETIC_TRAITS[trait])
    .filter((entry) => entry.available)
    .map((entry) => entry.key);

/** A slot's entries grouped by pack, base first, in pack order. */
const byPack = (trait: CosmeticTrait): ReadonlyArray<readonly [string, ReadonlyArray<CosmeticEntry>]> => {
  const groups = new Map<string, CosmeticEntry[]>();
  for (const entry of cosmeticEntries(PORTRAIT_COSMETIC_TRAITS[trait])) {
    const group = groups.get(entry.packId) ?? [];
    group.push(entry);
    groups.set(entry.packId, group);
  }
  return [...groups.values()].map((entries) => [entries[0]!.packName, entries] as const);
};

const randomConfig = (): PortraitConfig => {
  const any = <T,>(items: ReadonlyArray<T>): T => items[Math.floor(Math.random() * items.length)] as T;
  const options = portraitOptions();
  return {
    bodyHue: any(wearable("bodyHue")),
    accentHue: any(options.accentHue),
    shape: any(wearable("shape")),
    topper: any(wearable("topper")),
    eyes: any(options.eyes),
    mouth: any(options.mouth),
    brows: any(options.brows),
    marking: any(wearable("marking")),
    accessory: any(wearable("accessory")),
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

        {TRAITS.map(([trait, label]) => {
          const option = (key: string, name: string, available = true): ReactNode => {
            const active = character[trait] === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={active}
                aria-disabled={available ? undefined : true}
                aria-label={`${label} ${name}${available ? "" : ", locked"}`}
                title={available ? name : `${name}, not unlocked on this install`}
                className="portrait-editor__option"
                data-active={active ? "true" : undefined}
                data-locked={available ? undefined : "true"}
                onClick={() => (available ? set(trait, key as never) : hasStore() && openStore())}
              >
                <AgentPortrait
                  identity={identity}
                  size={40}
                  frame="round"
                  config={available ? { ...draft, [trait]: key } : draft}
                />
              </button>
            );
          };
          const groups = isCosmeticTrait(trait) ? byPack(trait) : [[undefined, undefined] as const];
          return (
            <section key={trait} className="portrait-editor__trait">
              <Eyebrow tone="steel" size="xs">
                {label}
              </Eyebrow>
              <div role="radiogroup" aria-label={label} className="portrait-editor__groups">
                {groups.map(([packName, entries], index) => (
                  <div key={packName ?? "face"} className="portrait-editor__pack" data-pack={index > 0 ? "premium" : undefined}>
                    {index > 0 ? (
                      <div className="portrait-editor__pack-head">
                        <span>{packName}</span>
                        {hasStore() && entries?.some((entry) => !entry.available) ? (
                          <Button size="xs" variant="subtle" onClick={openStore}>
                            Get
                          </Button>
                        ) : null}
                      </div>
                    ) : null}
                    <div className="portrait-editor__grid">
                      {entries
                        ? entries.map((entry) => option(entry.key, entry.item.name, entry.available))
                        : portraitOptions()[trait].map((key) => option(key, key))}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}

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
