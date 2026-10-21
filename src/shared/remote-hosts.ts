import { Schema } from "effect";
import { isValidMachineName } from "./machine-identity";
import type { EncodedFailure } from "./failure";

/** Machine registry read model, separate from the link protocol. */
export const REMOTE_HOSTS_VERSION = 1;

export const TERMINAL_HOST_CAPABILITY = "terminal" as const;
export const BROWSER_HOST_CAPABILITY = "browser" as const;
export const HostCapability = Schema.Literals([BROWSER_HOST_CAPABILITY, TERMINAL_HOST_CAPABILITY]);
export type HostCapability = typeof HostCapability.Type;

/** Product host id: stable, option-safe, not a leading dash. */
export const HostId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.makeFilter(isValidMachineName)),
);
export type HostId = typeof HostId.Type;

export const HostLabel = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
);
export type HostLabel = typeof HostLabel.Type;

/** SSH config alias, user@host, or IPv6 literal; the port is separate. */
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

export const RemoteHost = Schema.Struct({
  id: HostId,
  label: HostLabel,
  isThisMachine: Schema.Boolean,
  /** A machine may be known before it has an outbound SSH route. */
  sshEndpoint: Schema.optionalKey(HostSshEndpoint),
  /** Optional OpenSSH-owned identity selector for this exact route. */
  sshIdentityFile: Schema.optionalKey(HostSshIdentityFile),
  sshPort: Schema.optionalKey(Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: 65535 })))),
  sshKnownHostsFile: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(1024)), Schema.check(Schema.isPattern(/^\/[A-Za-z0-9._/@+-]+$/)))),
  sshHostKeyAlias: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(255)), Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/)))),
  juntoHome: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)), Schema.check(Schema.isPattern(/^\/[^\u0000-\u001f\u007f]*$/)))),
  installRoot: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMaxLength(2048)), Schema.check(Schema.isPattern(/^\/[^\u0000-\u001f\u007f]*$/)))),
  /** Explicit first-contact policy; changed known keys still fail closed. */
  sshHostKeyPolicy: Schema.optionalKey(HostSshHostKeyPolicy),
  capabilities: Schema.Array(HostCapability).pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(2)),
  ),
  /** Machine presentation. */
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

/** Surfaces available on the running machine, never a stored claim. */
export const THIS_MACHINE_CAPABILITIES: ReadonlyArray<HostCapability> = [
  TERMINAL_HOST_CAPABILITY, BROWSER_HOST_CAPABILITY,
];
export type MachinePresentation = {
  readonly label?: string;
  readonly appearance?: RemoteHost["appearance"];
};
export const makeThisMachine = (name: string, presentation: MachinePresentation = {}): RemoteHost => {
  if (!isValidMachineName(name)) throw new Error("this machine requires its persisted short name");
  return {
    id: name, label: presentation.label?.trim() || name, isThisMachine: true,
    capabilities: [...THIS_MACHINE_CAPABILITIES],
    ...(presentation.appearance ? { appearance: presentation.appearance } : {}),
  };
};
/** Preserve durable identity and presentation; restore process-owned capabilities. */
export const projectMachines = (hosts: ReadonlyArray<RemoteHost>): ReadonlyArray<RemoteHost> =>
  hosts.map(host => host.isThisMachine ? makeThisMachine(host.id, host) : host);

/** Before hydration no machine identity is assumed. */
export const defaultRemoteHostsDocument = (name?: string): RemoteHostsDocument => ({
  version: REMOTE_HOSTS_VERSION, hosts: name === undefined ? [] : [makeThisMachine(name)],
});
export const hostHasCapability = (host: RemoteHost, capability: HostCapability): boolean =>
  (host.isThisMachine ? THIS_MACHINE_CAPABILITIES : host.capabilities).includes(capability);

export const isLocalHost = (host: RemoteHost): boolean =>
  host.isThisMachine;

export class RemoteHostsError extends Error {
  readonly code: "io" | "validation" | "not_found" | "conflict";
  /** The typed chain behind the message, from the one encoder, when a cause was wrapped. */
  readonly failure?: EncodedFailure;
  constructor(
    code: RemoteHostsError["code"],
    message: string,
    failure?: EncodedFailure,
  ) {
    super(message);
    this.name = "RemoteHostsError";
    this.code = code;
    if (failure !== undefined) this.failure = failure;
  }
}
