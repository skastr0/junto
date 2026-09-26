import { FREE_PACK, FREE_PACK_ID } from "./free-pack";
import type {
  CosmeticAccessory,
  CosmeticPack,
  IdentityTables,
  CosmeticPalette,
  CosmeticPattern,
  CosmeticSpecies,
  CosmeticTopper,
} from "./pack-schema";

// The cosmetic catalog: the free items of the Junto cast (the built-in pack)
// plus the premium items of any packs the build's
// overlay bundled (premium content lives only in the official build). One
// lookup for every item, free or premium, so there is one path.
//
// Keys: free items keep their plain id ("toast"), so every saved override
// stays valid; pack items are "<pack>:<item>", unless the pack declares bare
// keys (then its items keep plain ids too, and "<pack>:<item>" still
// resolves). A key that is not in the catalog, or not available, resolves to
// nothing and the portrait falls back to the seat's identity look, never a
// broken portrait.

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
  readonly tier: "free" | "premium";
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

export const cosmeticKey = (pack: Pick<CosmeticPack, "id" | "keys">, itemId: string): string =>
  pack.id === FREE_PACK_ID || pack.keys === "bare" ? itemId : `${pack.id}:${itemId}`;

/**
 * The one entitlement seam. Every item is available today; a future
 * purchase check plugs in here and nowhere else. Base items always are.
 */
export const isCosmeticAvailable = (_entry: Omit<CosmeticEntry, "available">): boolean => true;

let packs: ReadonlyArray<CosmeticPack> = [FREE_PACK];
let revision = 0;
let index = new Map<string, CosmeticEntry>();
/** "<pack>:<item>" for bare-key packs, mapped to the entry's bare key. */
let aliases = new Map<string, string>();

const rebuild = (): void => {
  const next = new Map<string, CosmeticEntry>();
  const nextAliases = new Map<string, string>();
  for (const pack of packs) {
    for (const slot of Object.keys(LIST_KEY) as CosmeticSlot[]) {
      const items = (pack[LIST_KEY[slot]] ?? []) as ReadonlyArray<CosmeticItemBySlot[typeof slot]>;
      for (const item of items) {
        const key = cosmeticKey(pack, item.id);
        const mapKey = `${slot}|${key}`;
        if (next.has(mapKey)) continue;
        if (pack.keys === "bare" && pack.id !== FREE_PACK_ID) nextAliases.set(`${slot}|${pack.id}:${item.id}`, mapKey);
        const draft = {
          key,
          slot,
          packId: pack.id,
          packName: pack.name,
          tier: pack.id === FREE_PACK_ID ? ("free" as const) : (item.tier ?? pack.tier),
          item,
        };
        next.set(mapKey, { ...draft, available: isCosmeticAvailable(draft) });
      }
    }
  }
  index = next;
  aliases = nextAliases;
};
rebuild();

/**
 * Install the packs the build bundled (already decoded). The free pack is
 * always first and cannot be replaced; a pack id seen twice keeps the first.
 */
export function installCosmeticPacks(extra: ReadonlyArray<CosmeticPack>): number {
  const seen = new Set<string>([FREE_PACK_ID]);
  const next: CosmeticPack[] = [FREE_PACK];
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
  const mapKey = `${slot}|${key}`;
  const entry = index.get(aliases.get(mapKey) ?? mapKey) as CosmeticEntry<S> | undefined;
  return entry?.available ? entry : undefined;
}

export type IdentityTable = Exclude<keyof IdentityTables, "palettes">;

/** A seat-identity draw list: from the last installed pack declaring it. */
export function identityTable(name: IdentityTable): ReadonlyArray<string> {
  for (let at = packs.length - 1; at >= 0; at -= 1) {
    const list = packs[at]?.identity?.[name];
    if (list) return list;
  }
  return [];
}

/** The body palette draw with weights, from the last pack declaring one. */
export function identityPalettes(): ReadonlyArray<readonly [string, number]> {
  for (let at = packs.length - 1; at >= 0; at -= 1) {
    const list = packs[at]?.identity?.palettes;
    if (list) return list;
  }
  return [];
}

/** The free pack's list: where an unavailable draw falls back. */
export const freeIdentityTable = (name: IdentityTable): ReadonlyArray<string> => FREE_PACK.identity?.[name] ?? [];

/** Every item in a slot, free items first, in pack order. */
export function cosmeticEntries<S extends CosmeticSlot>(slot: S): ReadonlyArray<CosmeticEntry<S>> {
  const out: CosmeticEntry<S>[] = [];
  for (const [mapKey, entry] of index) if (mapKey.startsWith(`${slot}|`)) out.push(entry as CosmeticEntry<S>);
  return out;
}
