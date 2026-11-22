/**
 * The board the loom's workers route, packed once on the page (issue 912).
 * Every worker needs every card, as the furniture its wires route around,
 * but only its own share of the wires. Posting the card objects to each
 * worker cloned the whole graph once per worker on the page's thread; packed,
 * the cards are one number array and one string, which a post copies as flat
 * memory, and each worker is posted only the wires it routes.
 */
import type { Side } from "@shared/model";
import { shareOf, type LoomCard, type LoomWireRow } from "./loom-planner";

/** Floats per card in `rects`: x, y, width, height, and 1 for a region. */
const CARD_FLOATS = 5;
/** Between one id and the next, and between one wire and the next. */
const ROW = "\u0001";
/** Between a wire's fields. */
const FIELD = "\u0002";

export type PackedCards = { readonly ids: string; readonly rects: Float64Array };

export const packCards = (cards: ReadonlyArray<LoomCard>): PackedCards => {
  const rects = new Float64Array(cards.length * CARD_FLOATS);
  const ids: string[] = new Array(cards.length);
  for (let i = 0; i < cards.length; i += 1) {
    const card = cards[i]!;
    ids[i] = card.id;
    const at = i * CARD_FLOATS;
    rects[at] = card.x;
    rects[at + 1] = card.y;
    rects[at + 2] = card.width;
    rects[at + 3] = card.height;
    rects[at + 4] = card.region ? 1 : 0;
  }
  return { ids: ids.join(ROW), rects };
};

export const unpackCards = (packed: PackedCards): LoomCard[] => {
  const count = packed.rects.length / CARD_FLOATS;
  if (count === 0) return [];
  const ids = packed.ids.split(ROW);
  const cards: LoomCard[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const at = i * CARD_FLOATS;
    cards[i] = {
      id: ids[i]!,
      x: packed.rects[at]!,
      y: packed.rects[at + 1]!,
      width: packed.rects[at + 2]!,
      height: packed.rects[at + 3]!,
      region: packed.rects[at + 4] === 1,
    };
  }
  return cards;
};

/** The wires split into `count` shares, each packed as one string. */
export const packWireShares = (rows: ReadonlyArray<LoomWireRow>, count: number): string[] => {
  const shares: string[][] = Array.from({ length: count }, () => []);
  for (const row of rows) {
    shares[count === 1 ? 0 : shareOf(row.id, count)]!.push(
      [row.id, row.from, row.to, row.fromSide ?? "", row.toSide ?? ""].join(FIELD),
    );
  }
  return shares.map((share) => share.join(ROW));
};

export const unpackWires = (packed: string): LoomWireRow[] => {
  if (packed === "") return [];
  return packed.split(ROW).map((line) => {
    const [id, from, to, fromSide, toSide] = line.split(FIELD) as [string, string, string, string, string];
    return {
      id,
      from,
      to,
      ...(fromSide === "" ? {} : { fromSide: fromSide as Side }),
      ...(toSide === "" ? {} : { toSide: toSide as Side }),
    };
  });
};
