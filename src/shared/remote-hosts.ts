import { Schema } from "effect";

// Durable remote-host registry under ~/.vellum/hosts.json.
// The document is the product surface for multi-host fleets; source constants
// only seed defaults so existing local + remote-a setups keep working.

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

/** SSH config Host alias or user@host[:port]-style endpoint. */
export const HostEndpoint = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(255),
  Schema.pattern(/^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/),
);
export type HostEndpoint = typeof HostEndpoint.Type;

/**
 * Optional alternate id used in hermes agent keys (`<hermesId>:<profile>`).
 * Defaults to stripping hyphens from `id` for the legacy remote-a → remote-a
 * mapping when omitted at write time.
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

export const defaultRemoteHostsDocument = (): RemoteHostsDocument => ({
  version: REMOTE_HOSTS_VERSION,
  hosts: [
    {
      id: "local",
      label: "local",
      kind: "local",
      capabilities: ["herdr", "hermes"],
    },
    {
      id: "remote-a",
      label: "remote-a",
      kind: "remote",
      endpoint: "remote-a",
      capabilities: ["herdr", "hermes"],
      // Hermes agent keys historically used remote-a (no hyphen).
      hermesId: "remote-a",
    },
  ],
});

export const hostHasCapability = (
  host: RemoteHost,
  capability: HostCapability,
): boolean => host.capabilities.includes(capability);

export const hermesKeyFor = (host: RemoteHost): string =>
  host.hermesId ?? host.id.replace(/-/g, "");

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
