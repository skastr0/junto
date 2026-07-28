/**
 * Build-time feed selection for Mac Command Center self-update.
 *
 * Packaged apps never accept a runtime arbitrary feed URL override.
 * --channel is Dodo licensing and must not be reused here.
 */

/** Production generic provider base — latest-mac.yml lives here. */
export const MAC_ARM64_UPDATE_FEED_URL =
  "https://releases.vellumcommand.com/mac/arm64" as const;

export type UpdateFeedConfig = {
  readonly provider: "generic";
  readonly url: string;
};

export const macArm64UpdateFeed = (): UpdateFeedConfig => ({
  provider: "generic",
  url: MAC_ARM64_UPDATE_FEED_URL,
});
