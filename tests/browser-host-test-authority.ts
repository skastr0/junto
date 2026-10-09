import type { BrowserHostCapabilityAuthority } from "../src/main/junto/browser/host-capability";
import type { RemoteHost } from "../src/shared/remote-hosts";

export const LOCAL_BROWSER_TEST_HOST = Object.freeze({
  id: "studio",
  label: "studio",
  isThisMachine: true,
  capabilities: ["browser", "terminal", "hermes"] as const,
} satisfies RemoteHost);

/** Explicit machine identity for tests that exercise browser creation here. */
export const LOCAL_BROWSER_TEST_AUTHORITY = Object.freeze({
    findHost: (hostId: string) =>
      hostId === LOCAL_BROWSER_TEST_HOST.id
        ? LOCAL_BROWSER_TEST_HOST
        : undefined,
    machineName: () => LOCAL_BROWSER_TEST_HOST.id,
  } satisfies BrowserHostCapabilityAuthority);
