import type { BrowserHostCapabilityAuthority } from "../src/main/vellum/browser/host-capability";
import type { RemoteHost } from "../src/shared/remote-hosts";

export const LOCAL_BROWSER_TEST_HOST = Object.freeze({
  id: "local",
  label: "local",
  kind: "local",
  capabilities: ["browser", "terminal", "herdr", "hermes"] as const,
} satisfies RemoteHost);

/** Explicit physical identity for tests that exercise local browser creation. */
export const LOCAL_BROWSER_TEST_AUTHORITY = Object.freeze({
    findHost: (hostId: string) =>
      hostId === LOCAL_BROWSER_TEST_HOST.id
        ? LOCAL_BROWSER_TEST_HOST
        : undefined,
    station: () => ({
      hostId: LOCAL_BROWSER_TEST_HOST.id,
      role: "command-center" as const,
    }),
  } satisfies BrowserHostCapabilityAuthority);
