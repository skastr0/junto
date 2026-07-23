import { DEFAULT_STATION_HOST_ID } from "@shared/station";

/**
 * Page placement policy shared by every authoring entry point.
 *
 * A containing region's page.host is an explicit human selection and wins.
 * Source surfaces (Host Services / Herdr) preserve their own host as fallback;
 * generic Add Page supplies the current station as fallback.
 */
export const resolveAuthoredPageHost = (
  regionHost: string | undefined,
  sourceHost: string | undefined,
): string =>
  regionHost?.trim() ||
  sourceHost?.trim() ||
  DEFAULT_STATION_HOST_ID;
