import type { ComponentType } from "react";
import { Result, Schema } from "effect";

// The overlay contract: what an official build adds to the open-source app,
// resolved at BUILD time through the `@junto/overlay` alias (docs/overlay.md).
// A fork resolves the alias to the in-repo stub (src/overlay-oss) and builds a
// complete app with no store and no premium items. Nothing here is read from
// the filesystem at run time: whatever the overlay holds is in the bundle.
//
// Two entries, so data never drags UI into the main process:
//   @junto/overlay           -> `overlay`: OverlayManifest (data only)
//   @junto/overlay/renderer  -> `surfaces`: OverlaySurfaces (renderer UI)

/** Every overlay carries one marker literal; the OSS bundle check reads it. */
export const OVERLAY_MARKER_PATTERN = /junto-overlay:[a-z0-9][a-z0-9-]{0,31}/g;
export const OSS_OVERLAY_MARKER = "junto-overlay:oss";

export const OverlayManifest = Schema.Struct({
  /** `junto-overlay:<id>`; the stub is `junto-overlay:oss`. */
  marker: Schema.String.pipe(Schema.check(Schema.isPattern(/^junto-overlay:[a-z0-9][a-z0-9-]{0,31}$/))),
  /** Human name of the build flavor, for diagnostics. */
  name: Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(60))),
  /**
   * Premium cosmetic packs as raw data. Deliberately unknown here: the
   * portrait system decodes each pack with its own schema
   * (src/shared/cosmetics/pack-schema.ts) and drops a bad one alone.
   */
  cosmetics: Schema.Array(Schema.Unknown),
});
export type OverlayManifest = typeof OverlayManifest.Type;

const OSS_FALLBACK: OverlayManifest = { marker: OSS_OVERLAY_MARKER, name: "Open source", cosmetics: [] };

/** Decode the bundled overlay once; a malformed one degrades to the OSS app. */
export function decodeOverlay(input: unknown): OverlayManifest {
  const decoded = Schema.decodeUnknownResult(OverlayManifest)(input);
  if (Result.isSuccess(decoded)) return decoded.success;
  console.error("junto: overlay manifest is malformed; running without it");
  return OSS_FALLBACK;
}

/** Props the store surface receives from its host. */
export interface StoreSurfaceProps {
  readonly onClose: () => void;
}

/**
 * Named renderer extension points. Each is optional; the app renders a slot
 * only when the overlay fills it, so an OSS build shows none of them.
 */
export interface OverlaySurfaces {
  /** Premium store and purchase delivery: browse and get premium cosmetics. */
  readonly store?: {
    readonly title: string;
    readonly Component: ComponentType<StoreSurfaceProps>;
  };
}
