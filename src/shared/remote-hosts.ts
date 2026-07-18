import { Schema } from "effect";

// Durable remote-host registry under ~/.vellum/hosts.json.
// The document is the product surface for multi-host fleets. Source only seeds
// the immutable local host — remote machines are user-authored, never product
// constants.

export const REMOTE_HOSTS_VERSION = 1 as const;

export const HostCapability = Schema.Literal("herdr", "hermes");
export type HostCapability = typeof HostCapability.Type;

/** local = this machine; remote = OpenSSH endpoint (alias or user@host). */
export const HostKind = Schema.Literal("local", "remote");
export type HostKind = typeof HostKind.Type;

/** Product host id: stable, option-safe, not a leading dash. */
export const HostId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type HostId = typeof HostId.Type;

export const HostLabel = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
);
export type HostLabel = typeof HostLabel.Type;

/** SSH config alias, user@host, or IPv6 literal. Custom ports belong in ~/.ssh/config. */
export const HostEndpoint = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.pattern(/^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/),
);
export type HostEndpoint = typeof HostEndpoint.Type;

/**
 * Optional alternate id used in hermes agent keys (`<hermesId>:<profile>`).
 * When omitted, agent keys use `id` as written (no silent rewrite).
 */
export const HermesHostKey = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/),
);
export type HermesHostKey = typeof HermesHostKey.Type;

export const RemoteHost = Schema.Struct({
  id: HostId,
  label: HostLabel,
  kind: HostKind,
  endpoint: Schema.optionalWith(HostEndpoint, { exact: true }),
  capabilities: Schema.Array(HostCapability).pipe(
    Schema.minItems(1),
    Schema.maxItems(2),
  ),
  hermesId: Schema.optionalWith(HermesHostKey, { exact: true }),
});
export type RemoteHost = typeof RemoteHost.Type;

export const RemoteHostsDocument = Schema.Struct({
  version: Schema.Literal(REMOTE_HOSTS_VERSION),
  hosts: Schema.Array(RemoteHost).pipe(Schema.maxItems(32)),
});
export type RemoteHostsDocument = typeof RemoteHostsDocument.Type;

/** Only local is seeded. Remote hosts are added via Settings / hosts API. */
export const defaultRemoteHostsDocument = (): RemoteHostsDocument => ({
  version: REMOTE_HOSTS_VERSION,
  hosts: [
    {
      id: "local",
      label: "local",
      kind: "local",
      capabilities: ["herdr", "hermes"],
    },
  ],
});

export const hostHasCapability = (
  host: RemoteHost,
  capability: HostCapability,
): boolean => host.capabilities.includes(capability);

export const hermesKeyFor = (host: RemoteHost): string =>
  host.hermesId ?? host.id;

export const isLocalHost = (host: RemoteHost): boolean => host.kind === "local";

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
