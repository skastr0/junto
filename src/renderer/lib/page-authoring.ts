/**
 * The machine a new page goes on, shared by every authoring entry point.
 *
 * A containing region's page.host is an explicit human selection and wins.
 * Otherwise the page goes where its source is: the machine of the surface it
 * was made from, which for a plain Add page is this machine.
 */
export const resolveAuthoredPageHost = (
  regionHost: string | undefined,
  sourceHost: string,
): string => regionHost?.trim() || sourceHost.trim();
