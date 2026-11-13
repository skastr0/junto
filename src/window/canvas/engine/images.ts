/**
 * The image atlas (docs/canvas-gpu-architecture.md section 9). Portraits,
 * kind icons and kind bands are generated SVG; note and file images are
 * arbitrary bitmaps from the content store. One atlas, keyed by content and
 * size: the shell rasterizes (the contract's Rasterize — SVG data URI or
 * content ref in, bitmap out) because decoding SVG needs a document, and
 * hands the bitmap to the engine, which never fetches.
 *
 * What lives here: the key, the slot table, LRU eviction against a byte cap,
 * and the pending queue. Bitmaps are opaque to this module — the painter
 * (track C) uploads them and draws the quads; a portrait's 220 ms
 * expression cross-fade is two slots and a transition on the painter's
 * side, not atlas state.
 */

import type { Rasterize } from "../contract";

export interface ImageSource {
  /** Stable identity of the picture: a content ref, an SVG string's hash,
   *  or a generated-art key. Never a URL the engine fetches. */
  readonly key: string;
  readonly svg?: string;
  readonly url?: string;
}

export interface ImageCell {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** The rasterized bitmap, once the slot's job has run. */
  readonly bitmap?: ImageBitmap;
}

export interface ImageAtlasOptions {
  readonly byteCap: number;
}

export interface ImageAtlas {
  /** The cell for content at a size, or undefined while its raster is
   *  queued. Asking twice shares one job. */
  cell(source: ImageSource, width: number, height: number): ImageCell | undefined;
  /** Queue the raster; resolves to the cell with its bitmap. */
  want(source: ImageSource, width: number, height: number): Promise<ImageCell>;
  readonly stats: { readonly cells: number; readonly bytes: number; readonly queued: number };
}

/** The atlas key: content and size, nothing else (section 9). Theme lives
 *  in the SVG the shell hands in — portraits, icons and bands are
 *  regenerated per theme before they reach the key. */
export const imageKey = (source: ImageSource, width: number, height: number): string =>
  `${source.key}@${Math.round(width)}x${Math.round(height)}`;

export const createImageAtlas = (
  rasterize: Rasterize,
  options: ImageAtlasOptions,
): ImageAtlas => {
  const cells = new Map<string, ImageCell>();
  const pending = new Map<string, Promise<ImageCell>>();
  let bytes = 0;
  let tick = 0;
  const lru = new Map<string, number>();

  const evict = (): void => {
    while (bytes > options.byteCap && lru.size > 0) {
      let oldestKey: string | undefined;
      let oldest = Infinity;
      for (const [key, at] of lru) {
        if (at < oldest) {
          oldest = at;
          oldestKey = key;
        }
      }
      if (oldestKey === undefined) return;
      const cell = cells.get(oldestKey);
      if (cell) bytes -= cell.bytes;
      cells.delete(oldestKey);
      lru.delete(oldestKey);
    }
  };

  const want = (
    source: ImageSource,
    width: number,
    height: number,
  ): Promise<ImageCell> => {
    const key = imageKey(source, width, height);
    const existing = cells.get(key);
    if (existing) {
      lru.set(key, ++tick);
      return Promise.resolve(existing);
    }
    const job = pending.get(key);
    if (job) return job;
    const input = source.svg !== undefined ? { svg: source.svg } : { url: source.url! };
    const promise = rasterize(input, { width, height })
      .then((bitmap) => {
        const cell: ImageCell = {
          key,
          width,
          height,
          bytes: width * height * 4,
          bitmap,
        };
        cells.set(key, cell);
        lru.set(key, ++tick);
        bytes += cell.bytes;
        evict();
        return cell;
      })
      .finally(() => {
        pending.delete(key);
      });
    pending.set(key, promise);
    return promise;
  };

  return {
    cell: (source, width, height) => {
      const key = imageKey(source, width, height);
      const cell = cells.get(key);
      if (cell) lru.set(key, ++tick);
      return cell;
    },
    want,
    get stats() {
      return { cells: cells.size, bytes, queued: pending.size };
    },
  };
};
