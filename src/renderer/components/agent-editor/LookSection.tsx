import type { ReactNode } from "react";
import { PORTRAIT_COSMETIC_TRAITS, portraitOptions, type PortraitConfig } from "@shared/agent-portrait";
import { cosmeticEntries, type CosmeticEntry } from "@shared/cosmetics/catalog";
import "../../lib/cosmetics";
import { hasStore, openStore } from "../../overlay/surfaces";
import { AgentPortrait } from "../AgentPortrait";
import { Button, Eyebrow } from "../ui";
import { isEmptyConfig, useCharacterDraft } from "./character-draft";
import type { AgentEditorSectionProps } from "./sections";

// Look: every option is a thumbnail of this character wearing it, so the grid
// is the preview. Species, toppers, props, patterns, and colors come from the
// cosmetic catalog, grouped by pack: the base cast first, then each pack this
// build bundled. An item this install may not wear is shown locked and offers
// the store when the build has one; it never renders on a seat.

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

/** A random look; temperament is Mood's, so it keeps the current one. */
const randomLook = (temperament: number | undefined): PortraitConfig => {
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
    temperament,
  };
};

export function LookSection({ seat }: AgentEditorSectionProps) {
  const { identity, draft, character, set, replace } = useCharacterDraft();
  const lookChanged = !isEmptyConfig({ ...draft, temperament: undefined });

  return (
    <div className="agent-editor__look">
      <div className="agent-editor__row">
        <span className="agent-editor__hint">Every seat is born with a look. Pick anything to change it.</span>
        <div className="agent-editor__actions">
          <Button size="xs" variant="chrome" onClick={() => replace(randomLook(draft.temperament))}>
            Randomize
          </Button>
          <Button
            size="xs"
            variant="subtle"
            disabled={!lookChanged}
            title={`Back to the look ${seat.name} was born with`}
            onClick={() => replace({ temperament: draft.temperament })}
          >
            Reset
          </Button>
        </div>
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
              className="agent-editor__option"
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
          <section key={trait} className="agent-editor__trait">
            <Eyebrow tone="steel" size="xs">
              {label}
            </Eyebrow>
            <div role="radiogroup" aria-label={label} className="agent-editor__groups">
              {groups.map(([packName, entries], index) => (
                <div key={packName ?? "face"} className="agent-editor__pack" data-pack={index > 0 ? "premium" : undefined}>
                  {index > 0 ? (
                    <div className="agent-editor__pack-head">
                      <span>{packName}</span>
                      {hasStore() && entries?.some((entry) => !entry.available) ? (
                        <Button size="xs" variant="subtle" onClick={openStore}>
                          Get
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  <div className="agent-editor__grid">
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

      <label className="agent-editor__toggle">
        <input type="checkbox" checked={character.blush} onChange={(event) => set("blush", event.target.checked)} />
        <span>rosy cheeks</span>
      </label>
    </div>
  );
}
