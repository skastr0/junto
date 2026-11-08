import { Result, Schema } from "effect";
import { FREE_PACK, FREE_PACK_ID } from "./free-pack";
import { CosmeticPack } from "./pack-schema";

// Decodes the cosmetic packs a build bundled (the overlay's raw pack data).
// Each pack is decoded on its own: a bad pack is dropped with one clear log
// line and never takes the portraits, or any other pack, down with it.

const decodePack = Schema.decodeUnknownResult(CosmeticPack, { onExcessProperty: "error" });

export interface CosmeticPackRejection {
  readonly index: number;
  readonly id?: string;
  readonly reason: string;
}

const SLOT_LISTS = ["species", "toppers", "accessories", "patterns", "palettes"] as const;

/** "<list>|<id>" for every item of a pack: its bare keys, by slot. */
const bareKeys = (pack: CosmeticPack): ReadonlyArray<string> =>
  SLOT_LISTS.flatMap((list) => (pack[list] ?? []).map((item) => `${list}|${item.id}`));

const firstLine = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).split("\n").slice(0, 3).join(" ").slice(0, 300);

export function decodeCosmeticPacks(
  raw: ReadonlyArray<unknown>,
  onReject: (rejection: CosmeticPackRejection) => void = (rejection) =>
    console.warn(
      `junto: cosmetic pack ${rejection.id ?? `#${rejection.index}`} rejected: ${rejection.reason}`,
    ),
): ReadonlyArray<CosmeticPack> {
  const packs: CosmeticPack[] = [];
  const seen = new Set<string>([FREE_PACK_ID]);
  const bare = new Set<string>(bareKeys(FREE_PACK));
  raw.forEach((input, index) => {
    const id =
      input !== null && typeof input === "object" && typeof (input as { id?: unknown }).id === "string"
        ? ((input as { id: string }).id.slice(0, 40))
        : undefined;
    const decoded = decodePack(input);
    if (!Result.isSuccess(decoded)) {
      onReject({ index, ...(id ? { id } : {}), reason: firstLine(decoded.failure) });
      return;
    }
    const pack = decoded.success;
    if (seen.has(pack.id)) {
      onReject({ index, id: pack.id, reason: `pack id "${pack.id}" is already taken` });
      return;
    }
    if (pack.tier !== "premium") {
      onReject({ index, id: pack.id, reason: "only the built-in pack holds free items; bundled packs are premium" });
      return;
    }
    if (pack.keys === "bare") {
      const keys = bareKeys(pack);
      const taken = keys.find((key) => bare.has(key));
      if (taken) {
        onReject({ index, id: pack.id, reason: `bare key "${taken.split("|")[1]}" is already taken` });
        return;
      }
      for (const key of keys) bare.add(key);
    }
    seen.add(pack.id);
    packs.push(pack);
  });
  return packs;
}
