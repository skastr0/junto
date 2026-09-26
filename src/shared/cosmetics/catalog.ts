import { BASE_PACK, BASE_PACK_ID } from "./base-pack";
import type {
  CosmeticAccessory,
  CosmeticPack,
  CosmeticPalette,
  CosmeticPattern,
  CosmeticSpecies,
  CosmeticTopper,
} from "./pack-schema";

// The cosmetic catalog: the built-in base pack plus any packs the build's
// overlay bundled (premium content lives only in the official build). One
// lookup for every item, base or premium, so there is one path.
//
// Keys: base items keep their plain id ("toast"), so every saved override
// stays valid; pack items are "<pack>:<item>". A key that is not in the
// catalog, or not available, resolves to nothing and the portrait falls back
// to the seat's identity look, never a broken portrait.

export type CosmeticSlot = "species" | "topper" | "accessory" | "pattern" | "palette";

export interface CosmeticItemBySlot {
  readonly species: CosmeticSpecies;
  readonly topper: CosmeticTopper;
  readonly accessory: CosmeticAccessory;
  readonly pattern: CosmeticPattern;
  readonly palette: CosmeticPalette;
}

export interface CosmeticEntry<S extends CosmeticSlot = CosmeticSlot> {
  readonly key: string;
  readonly slot: S;
  readonly packId: string;
  readonly packName: string;
  readonly tier: "base" | "premium";
  /** Whether this install may wear it. See `isCosmeticAvailable`. */
  readonly available: boolean;
  readonly item: CosmeticItemBySlot[S];
}

const LIST_KEY: Readonly<Record<CosmeticSlot, keyof CosmeticPack>> = {
  species: "species",
  topper: "toppers",
  accessory: "accessories",
  pattern: "patterns",
  palette: "palettes",
};

export const cosmeticKey = (packId: string, itemId: string): string =>
  packId === BASE_PACK_ID ? itemId : `${packId}:${itemId}`;

/**
 * The one entitlement seam. Every item is available today; a future
 * purchase check plugs in here and nowhere else. Base items always are.
 */
export const isCosmeticAvailable = (_entry: Omit<CosmeticEntry, "available">): boolean => true;

let packs: ReadonlyArray<CosmeticPack> = [BASE_PACK];
let revision = 0;
let index = new Map<string, CosmeticEntry>();

const rebuild = (): void => {
  const next = new Map<string, CosmeticEntry>();
  for (const pack of packs) {
    for (const slot of Object.keys(LIST_KEY) as CosmeticSlot[]) {
      const items = (pack[LIST_KEY[slot]] ?? []) as ReadonlyArray<CosmeticItemBySlot[typeof slot]>;
      for (const item of items) {
        const key = cosmeticKey(pack.id, item.id);
        const mapKey = `${slot}|${key}`;
        if (next.has(mapKey)) continue;
        const draft = {
          key,
          slot,
          packId: pack.id,
          packName: pack.name,
          tier: pack.id === BASE_PACK_ID ? ("base" as const) : (item.tier ?? pack.tier),
          item,
        };
        next.set(mapKey, { ...draft, available: isCosmeticAvailable(draft) });
      }
    }
  }
  index = next;
};
rebuild();

/**
 * Install the packs the build bundled (already decoded). The base pack is
 * always first and cannot be replaced; a pack id seen twice keeps the first.
 */
export function installCosmeticPacks(extra: ReadonlyArray<CosmeticPack>): number {
  const seen = new Set<string>([BASE_PACK_ID]);
  const next: CosmeticPack[] = [BASE_PACK];
  for (const pack of extra) {
    if (seen.has(pack.id)) continue;
    seen.add(pack.id);
    next.push(pack);
  }
  packs = next;
  revision += 1;
  rebuild();
  return revision;
}

/** Bumps whenever the installed packs change; portraits cache by it. */
export const cosmeticsRevision = (): number => revision;

export const installedCosmeticPacks = (): ReadonlyArray<CosmeticPack> => packs;

/** An item a portrait may wear: present and available, else undefined. */
export function findCosmetic<S extends CosmeticSlot>(slot: S, key: unknown): CosmeticEntry<S> | undefined {
  if (typeof key !== "string") return undefined;
  const entry = index.get(`${slot}|${key}`) as CosmeticEntry<S> | undefined;
  return entry?.available ? entry : undefined;
}

/** Every item in a slot, base pack first, in pack order. */
export function cosmeticEntries<S extends CosmeticSlot>(slot: S): ReadonlyArray<CosmeticEntry<S>> {
  const out: CosmeticEntry<S>[] = [];
  for (const [mapKey, entry] of index) if (mapKey.startsWith(`${slot}|`)) out.push(entry as CosmeticEntry<S>);
  return out;
}
