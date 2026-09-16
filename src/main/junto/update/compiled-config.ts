/**
 * Fixed feed selection for Command Center self-update.
 *
 * Packaged apps never accept a runtime arbitrary feed URL override.
 *
 * Production origin:
 *   https://releases.juntoagents.com/mac/arm64
 *
 * The replacement Worker and bucket (junto-releases, JuntoReleaseDistribution)
 * are still pending deployment; the default below already points at the
 * production origin.
 */

declare const __JUNTO_MAC_UPDATE_FEED_URL__: string | undefined;

/** Production generic provider base for the Junto release feed. */
export const MAC_ARM64_UPDATE_FEED_URL_PRODUCTION =
  "https://releases.juntoagents.com/mac/arm64" as const;

/**
 * Interim GitHub public feed (used only when the release feed is unavailable).
 */
export const MAC_ARM64_UPDATE_FEED_URL_INTERIM =
  "https://github.com/skastr0/junto/releases/download/v0.1.0" as const;

/** Active packaged default: the production origin. */
export const MAC_ARM64_UPDATE_FEED_URL = MAC_ARM64_UPDATE_FEED_URL_PRODUCTION;

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
  url: MAC_ARM64_UPDATE_FEED_URL_PRODUCTION.replace(/\/mac\/arm64$/u, "/linux/x64"),
});
