/**
 * The shot a page box comment carries (plan 06, B7, remote-security's
 * screenshot ruling): main takes it from the live view, crops it to the box
 * and encodes it itself, so no source metadata survives, and it is judged
 * from its own bytes before it is stored.
 */

/** How long box drawing waits for the operator's drag before it ends with no box. */
export const PAGE_BOX_DRAW_MS = 5 * 60_000;

/** The most a shot holds. */
export const PAGE_SHOT_MAX_BYTES = 2 * 1024 * 1024;
/** The most a shot measures on either side, in its own pixels. */
export const PAGE_SHOT_MAX_PX = 4096;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/**
 * Pure: the size a PNG's header declares, or undefined when the bytes are
 * not a PNG whose first chunk is its header. Main encodes every shot as PNG,
 * so nothing else is a shot.
 */
export const pngSize = (bytes: Uint8Array): { readonly width: number; readonly height: number } | undefined => {
  if (bytes.byteLength < 24 || PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The first chunk: length 13, type IHDR, then width and height.
  if (view.getUint32(8) !== 13 || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return undefined;
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width === 0 || height === 0 ? undefined : { width, height };
};

export type PageShotRefusal = "empty" | "not_png" | "too_large" | "too_big";

/** Pure: why these bytes cannot be a shot, or undefined when they can. */
export const pageShotRefusal = (bytes: Uint8Array): PageShotRefusal | undefined => {
  if (bytes.byteLength === 0) return "empty";
  if (bytes.byteLength > PAGE_SHOT_MAX_BYTES) return "too_large";
  const size = pngSize(bytes);
  if (size === undefined) return "not_png";
  return size.width > PAGE_SHOT_MAX_PX || size.height > PAGE_SHOT_MAX_PX ? "too_big" : undefined;
};

/**
 * Pure: the page's address as a box comment keeps it: no name, password,
 * query or fragment, any of which can hold a token, since the comment
 * crosses machines with its thread. Undefined for an address that does not
 * parse: it is kept as nothing, and the comment is refused.
 */
export const pageBoxUrlOf = (url: string): string | undefined => {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return undefined;
  }
};

/** What the operator or a seat is told when a shot is refused. */
export const PAGE_SHOT_REFUSED: Readonly<Record<PageShotRefusal, string>> = {
  empty: "The page showed nothing to capture: open it and try again.",
  not_png: "The capture was not an image.",
  too_large: "That box makes a shot over 2 MB: draw a smaller box.",
  too_big: "That box is over 4096 pixels on a side: draw a smaller box.",
};

/** What a page box comment shows in place of a shot the operator removed. */
export const PAGE_SHOT_REMOVED = "Screenshot removed. The comment stays.";

/** The comment whose shot the operator removes: a reply names its thread's comment. */
export type PageShotPurgeRequest = { readonly canvasName: string; readonly nodeId: string; readonly messageId: string };

/** `already`: it was removed before, and nothing new crossed. */
export type PageShotPurged =
  | { readonly ok: true; readonly messageId: string; readonly already: boolean }
  | { readonly ok: false; readonly message: string };
