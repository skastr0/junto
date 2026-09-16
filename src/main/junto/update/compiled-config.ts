/**
 * Fixed feed selection for Command Center self-update.
 *
 * Packaged apps never accept a runtime arbitrary feed URL override.
 *
 * Production custom domain (after DNS):
 *   https://releases.vellumcommand.com/mac/arm64
 *
 * Live Worker (deployed; use until custom domain is wired):
 *   workers.dev base + /mac/arm64
 */

declare const __JUNTO_MAC_UPDATE_FEED_URL__: string | undefined;

/** Custom-domain production generic provider base (DNS still pending). */
export const MAC_ARM64_UPDATE_FEED_URL_CUSTOM_DOMAIN =
  "https://releases.vellumcommand.com/mac/arm64" as const;

/**
 * Live download surface published by the maintainer's release feed.
 * Bucket: vellum-releases. Update this if the Worker hostname changes.
 */
export const MAC_ARM64_UPDATE_FEED_URL_WORKER =
  "https://vellumreleasedistribution-rele2p3h3apcupwjim2zajqqmhyd.skastr052.workers.dev/mac/arm64" as const;

/**
 * Interim GitHub public feed (used only when Worker is unavailable).
 */
export const MAC_ARM64_UPDATE_FEED_URL_INTERIM =
  "https://github.com/skastr0/vellum-releases/releases/download/v0.1.0" as const;

/** Active packaged default: live Worker path. */
export const MAC_ARM64_UPDATE_FEED_URL = MAC_ARM64_UPDATE_FEED_URL_WORKER;

export type UpdateFeedConfig = {
  readonly provider: "generic";
  readonly url: string;
};

const compiledFeedUrl = (): string | undefined => {
  try {
    if (
      typeof __JUNTO_MAC_UPDATE_FEED_URL__ === "string" &&
      __JUNTO_MAC_UPDATE_FEED_URL__.trim().length > 0
    ) {
      return __JUNTO_MAC_UPDATE_FEED_URL__.trim().replace(/\/+$/u, "");
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

/** Linux desktop alpha has its own signed descriptor, distinct from Fleet. */
export const linuxX64UpdateFeed = (): UpdateFeedConfig => ({
  provider: "generic",
  url: MAC_ARM64_UPDATE_FEED_URL_WORKER.replace(/\/mac\/arm64$/u, "/linux/x64"),
});
