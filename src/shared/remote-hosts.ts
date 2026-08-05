import { Schema } from "effect";
import { BROWSER_ENABLED, HERDR_ENABLED } from "./features";

// Durable remote-host enrollment lives in the app-owned StateEngine database.
// Source only synthesizes the immutable local host — remote machines are
// enrolled through product APIs, never source constants or editable files.

export const REMOTE_HOSTS_VERSION = 1 as const;

export const TERMINAL_HOST_CAPABILITY = "terminal" as const;
export const BROWSER_HOST_CAPABILITY = "browser" as const;
export const HostCapability = Schema.Literals([BROWSER_HOST_CAPABILITY, "herdr",
"hermes",
TERMINAL_HOST_CAPABILITY,]);
export type HostCapability = typeof HostCapability.Type;

/** local = this machine; remote = OpenSSH endpoint (alias or user@host). */
export const HostKind = Schema.Literals(["local", "remote"]);
export type HostKind = typeof HostKind.Type;

/** Product host id: stable, option-safe, not a leading dash. */
export const HostId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/)),
);
export type HostId = typeof HostId.Type;

export const HostLabel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);
export type HostLabel = typeof HostLabel.Type;

/** SSH config alias, user@host, or IPv6 literal. Custom ports belong in ~/.ssh/config. */
export const HostSshEndpoint = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(255)),
  Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/)),
);
export type HostSshEndpoint = typeof HostSshEndpoint.Type;

/** Optional OpenSSH identity locator. The private key remains owned by OpenSSH. */
export const HostSshIdentityFile = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(1024)),
  Schema.check(Schema.makeFilter((value) =>
    value.startsWith("/") &&
    !value.includes("\u0000") &&
    !value.includes("\n") &&
    !value.includes("\r"),
  {
    message: "SSH identity file must be a bounded absolute path",
  },)),
);
export type HostSshIdentityFile = typeof HostSshIdentityFile.Type;

export const HostSshHostKeyPolicy = Schema.Literals(["system", "accept-new"]);
export type HostSshHostKeyPolicy = typeof HostSshHostKeyPolicy.Type;

/**
 * Optional alternate id used in hermes agent keys (`<hermesId>:<profile>`).
 * When omitted, agent keys use `id` as written (no silent rewrite).
 */
export const HermesHostKey = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/)),
);
export type HermesHostKey = typeof HermesHostKey.Type;

export const RemoteHost = Schema.Struct({
  id: HostId,
  label: HostLabel,
  kind: HostKind,
  /** Optional SSH route. Local rows omit it; remotes may omit until enrolled with a route. */
  sshEndpoint: Schema.optionalKey(HostSshEndpoint),
  /** Optional OpenSSH-owned identity selector for this exact route. */
  sshIdentityFile: Schema.optionalKey(HostSshIdentityFile),
  /** Explicit first-contact policy; changed known keys still fail closed. */
  sshHostKeyPolicy: Schema.optionalKey(HostSshHostKeyPolicy),
  capabilities: Schema.Array(HostCapability).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(4)),
  ),
  hermesId: Schema.optionalKey(HermesHostKey),
  /** Fleet-overlay presentation (color/glyph). Presentational; additive. */
  appearance: Schema.optionalKey(Schema.Struct({
    color: Schema.optionalKey(Schema.String),
    glyph: Schema.optionalKey(Schema.String),
  })),
});
export type RemoteHost = typeof RemoteHost.Type;

export const RemoteHostsDocument = Schema.Struct({
  version: Schema.Literal(REMOTE_HOSTS_VERSION),
  hosts: Schema.Array(RemoteHost).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type RemoteHostsDocument = typeof RemoteHostsDocument.Type;

/**
 * Stable routing id for this process / this station.
 * Not an enrollment fact — remotes are enrolled; this machine is the runtime.
 */
export const LOCAL_HOST_ID = "local" as const;

/**
 * Surfaces this Vellum Command process always owns. Persisted state may store a local
 * row for presentation (label/hermesId/appearance), but capabilities for local
 * are always this code default.
 */
export const LOCAL_STATION_CAPABILITIES: ReadonlyArray<HostCapability> = [
  TERMINAL_HOST_CAPABILITY,
  ...(BROWSER_ENABLED ? ([BROWSER_HOST_CAPABILITY] as const) : []),
  // Herdr is compile-gated (legacy). Schema still decodes historical rows.
  ...(HERDR_ENABLED ? (["herdr"] as const) : []),
  "hermes",
];

export type LocalHostPresentation = {
  readonly label?: string;
  readonly hermesId?: HermesHostKey;
  readonly appearance?: RemoteHost["appearance"];
};

/** Build the this-machine host record from code defaults + optional presentation. */
export const makeLocalHost = (
  presentation: LocalHostPresentation = {},
): RemoteHost => ({
  id: LOCAL_HOST_ID,
  label: presentation.label?.trim() || LOCAL_HOST_ID,
  kind: "local",
  capabilities: [...LOCAL_STATION_CAPABILITIES],
  ...(presentation.hermesId ? { hermesId: presentation.hermesId } : {}),
  ...(presentation.appearance ? { appearance: presentation.appearance } : {}),
});

/**
 * Runtime projection: remotes stay user-authored; local is always the code
 * default (caps from process fact). Optional `label` is the dynamic display
 * name (e.g. OS hostname) when the stored label is absent or still "local".
 */
export const projectHostsWithCodeDefaultLocal = (
  hosts: ReadonlyArray<RemoteHost>,
  options: { readonly label?: string } = {},
): ReadonlyArray<RemoteHost> => {
  const remotes = hosts.filter(
    (host) => host.kind === "remote" && host.id !== LOCAL_HOST_ID,
  );
  const stored = hosts.find(
    (host) => host.id === LOCAL_HOST_ID && host.kind === "local",
  );
  const storedLabel = stored?.label?.trim();
  const label =
    storedLabel && storedLabel !== LOCAL_HOST_ID
      ? storedLabel
      : options.label?.trim() || storedLabel || LOCAL_HOST_ID;
  return [
    makeLocalHost({
      label,
      hermesId: stored?.hermesId,
      appearance: stored?.appearance,
    }),
    ...remotes,
  ];
};

/** Seed / fail-closed document: this machine only (code default). */
export const defaultRemoteHostsDocument = (): RemoteHostsDocument => ({
  version: REMOTE_HOSTS_VERSION,
  hosts: [makeLocalHost()],
});

export const hostHasCapability = (
  host: RemoteHost,
  capability: HostCapability,
): boolean =>
  host.id === LOCAL_HOST_ID || host.kind === "local"
    ? LOCAL_STATION_CAPABILITIES.includes(capability)
    : host.capabilities.includes(capability);

export const hermesKeyFor = (host: RemoteHost): string =>
  host.hermesId ?? host.id;

export const isLocalHost = (host: RemoteHost): boolean =>
  host.kind === "local" || host.id === LOCAL_HOST_ID;

export class RemoteHostsError extends Error {
  readonly code: "io" | "validation" | "not_found" | "conflict";
  constructor(
    code: RemoteHostsError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RemoteHostsError";
    this.code = code;
  }
}
