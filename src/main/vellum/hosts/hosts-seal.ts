/**
 * Hosts registry seal — Phase 3 parallel of station topology seal.
 *
 * Mental model:
 * - `hosts.json` remains a readable enrollment document (endpoints, capabilities).
 * - Authority to **admit** that membership at process start is the seal, not
 *   an offline plaintext edit alone.
 *
 * Mechanism (app-owned integrity, not a crypto vault):
 * - `hosts.key`  — machine-local HMAC secret (32 bytes, mode 0600)
 * - `hosts.seal` — JSON `{ version, alg, mac }` over a canonical hosts body
 *
 * Admit rules on load (after schema decode):
 * - key+seal absent → **bootstrap** (first run / upgrade) — accept + write seal
 * - key present, seal missing | seal present, key missing | MAC mismatch |
 *   corrupt seal → **fail closed** — local-only default registry
 * - both present + MAC ok → accept
 *
 * Residual risk until a full protected store: same-user who can delete both
 * `hosts.key` and `hosts.seal` can re-bootstrap a forged fleet. Editing
 * `hosts.json` alone after a seal exists does not mint membership.
 *
 * See docs/protected-topology-migration.md.
 */

import {
  SEAL_ALG,
  debugMacForBody,
  sealPathsBeside,
  verifySealFile,
  writeSealFile,
  type SealPaths,
  type SealVerifyStatus,
} from "../document-seal";
import {
  defaultRemoteHostsDocument,
  type RemoteHostsDocument as RemoteHostsDocumentT,
  type RemoteHost,
} from "@shared/remote-hosts";

export const HOSTS_KEY_BASENAME = "hosts.key";
export const HOSTS_SEAL_BASENAME = "hosts.seal";
export const HOSTS_SEAL_VERSION = 1 as const;
export const HOSTS_SEAL_ALG = SEAL_ALG;
/** Domain separation tag (must stay stable for existing seals). */
export const HOSTS_SEAL_DOMAIN = "vellum-hosts-v1\0";

export type HostsVerifyStatus = SealVerifyStatus;

export const hostsPathsForDocument = (hostsPath: string): SealPaths =>
  sealPathsBeside(hostsPath, HOSTS_KEY_BASENAME, HOSTS_SEAL_BASENAME);

/**
 * Canonical JSON body for HMAC. Fixed key order per host; optional fields only
 * when set. Host array order is significant (membership). Capabilities order
 * is preserved as authored. Stable across runtimes — do not pretty-print.
 */
export const canonicalizeHostsDocument = (
  document: RemoteHostsDocumentT,
): Buffer => {
  const hosts = document.hosts.map((host) => canonicalizeHost(host));
  // Top-level keys sorted: hosts, version.
  return Buffer.from(
    JSON.stringify({ hosts, version: document.version }),
    "utf8",
  );
};

const canonicalizeHost = (host: RemoteHost): Record<string, unknown> => {
  const body: Record<string, unknown> = {
    capabilities: [...host.capabilities],
    id: host.id,
    kind: host.kind,
    label: host.label,
  };
  if (host.endpoint !== undefined) body.endpoint = host.endpoint;
  if (host.hermesId !== undefined) body.hermesId = host.hermesId;
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(body).sort()) {
    ordered[key] = body[key];
  }
  return ordered;
};

/** Write (or overwrite) the seal for the given hosts document. */
export const writeHostsSeal = async (
  hostsPath: string,
  document: RemoteHostsDocumentT,
): Promise<void> => {
  const paths = hostsPathsForDocument(hostsPath);
  await writeSealFile(
    paths,
    HOSTS_SEAL_DOMAIN,
    HOSTS_SEAL_VERSION,
    HOSTS_SEAL_ALG,
    canonicalizeHostsDocument(document),
  );
};

export const verifyHostsSeal = async (
  hostsPath: string,
  document: RemoteHostsDocumentT,
): Promise<HostsVerifyStatus> => {
  const paths = hostsPathsForDocument(hostsPath);
  return verifySealFile(
    paths,
    HOSTS_SEAL_DOMAIN,
    HOSTS_SEAL_VERSION,
    HOSTS_SEAL_ALG,
    canonicalizeHostsDocument(document),
  );
};

/**
 * Admit enrollment topology from a loaded hosts document.
 * On reject: returns local-only default (fail closed). Does not rewrite
 * hosts.json — caller persists when appropriate. Always ensures a seal for
 * the admitted document (bootstrap or after strip).
 */
export const admitHostsDocument = async (
  hostsPath: string,
  document: RemoteHostsDocumentT,
): Promise<{
  readonly document: RemoteHostsDocumentT;
  readonly outcome: "valid" | "bootstrap" | "stripped";
  readonly reason?: string;
}> => {
  const verified = await verifyHostsSeal(hostsPath, document);

  if (verified.status === "valid") {
    return { document, outcome: "valid" };
  }

  if (verified.status === "bootstrap") {
    await writeHostsSeal(hostsPath, document);
    return { document, outcome: "bootstrap", reason: verified.reason };
  }

  const stripped = defaultRemoteHostsDocument();
  await writeHostsSeal(hostsPath, stripped);
  return {
    document: stripped,
    outcome: "stripped",
    reason: verified.reason,
  };
};

/** Pure helper for tests: compute MAC for a known key. */
export const debugHostsMacForTests = (
  key: Buffer,
  document: RemoteHostsDocumentT,
): string =>
  debugMacForBody(key, HOSTS_SEAL_DOMAIN, canonicalizeHostsDocument(document));
