/**
 * Build-time feed selection for Mac Command Center self-update.
 *
 * Packaged apps never accept a runtime arbitrary feed URL override.
 * --channel is Dodo licensing and must not be reused here.
 *
 * Production target remains Cloudflare:
 *   https://releases.vellumcommand.com/mac/arm64
 * Until R2 is enabled on the Cloudflare account, the interim public feed is
 * the skastr0/vellum-releases GitHub release assets (generic provider).
 */

declare const __VELLUM_MAC_UPDATE_FEED_URL__: string | undefined;

/** Intended production generic provider base (Cloudflare Worker + R2). */
export const MAC_ARM64_UPDATE_FEED_URL_CLOUDFLARE =
  "https://releases.vellumcommand.com/mac/arm64" as const;

/**
 * Interim public generic feed while Cloudflare R2 is disabled.
 * Points at the latest prerelease tag assets under skastr0/vellum-releases.
 */
export const MAC_ARM64_UPDATE_FEED_URL_INTERIM =
  "https://github.com/skastr0/vellum-releases/releases/download/v0.1.0" as const;

/** Active packaged default until Cloudflare production feed is live. */
export const MAC_ARM64_UPDATE_FEED_URL =
  MAC_ARM64_UPDATE_FEED_URL_INTERIM;

export type UpdateFeedConfig = {
  readonly provider: "generic";
  readonly url: string;
};

const compiledFeedUrl = (): string | undefined => {
  try {
    if (
      typeof __VELLUM_MAC_UPDATE_FEED_URL__ === "string" &&
      __VELLUM_MAC_UPDATE_FEED_URL__.trim().length > 0
    ) {
      return __VELLUM_MAC_UPDATE_FEED_URL__.trim().replace(/\/+$/u, "");
    }
  } catch {
    // Symbol may be undefined in unit tests without vite define.
  }
  return undefined;
};

export const macArm64UpdateFeed = (): UpdateFeedConfig => ({
  provider: "generic",
  url: compiledFeedUrl() ?? MAC_ARM64_UPDATE_FEED_URL,
});
