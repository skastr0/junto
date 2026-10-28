/**
 * Links bound to their opener's key (docs/machines.md, The link): the owner
 * commands that set one up. `machine link` runs on the editing machine, which
 * already has a route to both ends; the other three run on those ends, over
 * that route, by their own Junto.
 */
import { Schema } from "effect";
import { InstallationId } from "./installation-id";
import { MachineAbsolutePath } from "./machine-install";
import { isValidMachineName } from "./machine-identity";
import { HostSshEndpoint } from "./remote-hosts";

const Name = Schema.String.pipe(Schema.check(Schema.makeFilter(isValidMachineName)));
const Port = Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 65_535 })));
/** One ssh-ed25519 public key; link-keys.ts checks its blob before any line is built. */
const PublicKey = Schema.String.pipe(Schema.check(Schema.isMaxLength(256)), Schema.check(Schema.isPattern(/^ssh-ed25519 [A-Za-z0-9+/]{16,}={0,3}$/)));
const LiteralUser = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/)));
const LiteralHost = Schema.String.pipe(Schema.check(Schema.isMaxLength(254)), Schema.check(Schema.isPattern(/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/)));

/** A route as ssh -G resolved it once, and as a bound link dials it with -F none. */
export const MachineLinkRoute = Schema.Struct({ machine: Name, user: LiteralUser, host: LiteralHost, port: Port });
export type MachineLinkRoute = typeof MachineLinkRoute.Type;

/**
 * `from` dials `to` with a key bound to it. `sshTarget` and `sshPort` are how
 * `from` reaches `to`, when not the way this machine does.
 */
export const MachineLinkInput = Schema.Struct({
  from: Name, to: Name,
  sshTarget: Schema.optionalKey(HostSshEndpoint),
  sshPort: Schema.optionalKey(Port),
});
export type MachineLinkInput = typeof MachineLinkInput.Type;
/** Every route this setup recorded: `from` to `to`, and this machine to each end it keyed. */
export const MachineLinkData = Schema.Struct({
  from: Name, to: Name,
  routes: Schema.Array(Schema.Struct({ ...MachineLinkRoute.fields, from: Name })).pipe(Schema.check(Schema.isMaxLength(3))),
});
export type MachineLinkData = typeof MachineLinkData.Type;

/** On the machine that will dial: a new key for links to `peer`. */
export const MachineLinkKeyInput = Schema.Struct({ peer: Name, replace: Schema.optionalKey(Schema.Boolean) });
export type MachineLinkKeyInput = typeof MachineLinkKeyInput.Type;
export const MachineLinkKeyData = Schema.Struct({ machineName: Name, installationId: InstallationId, publicKey: PublicKey });
export type MachineLinkKeyData = typeof MachineLinkKeyData.Type;

export const MachineLinkOpener = Schema.Struct({ machineName: Name, installationId: InstallationId, publicKey: PublicKey });
export type MachineLinkOpener = typeof MachineLinkOpener.Type;
/** On the machine that will receive: pin each opener with its key and write its line. */
export const MachineLinkAcceptInput = Schema.Struct({
  openers: Schema.Array(MachineLinkOpener).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(2))),
});
export type MachineLinkAcceptInput = typeof MachineLinkAcceptInput.Type;
export const MachineLinkAcceptData = Schema.Struct({
  pins: Schema.Array(Schema.Struct({ machineName: Name, installationId: InstallationId, boundAt: Schema.String })).pipe(Schema.check(Schema.isMaxLength(2))),
});
export type MachineLinkAcceptData = typeof MachineLinkAcceptData.Type;

/** On the machine that will dial: record the route and host keys for `name`, then dial it once to pin it. */
export const MachineLinkOpenInput = Schema.Struct({
  name: Name, installationId: InstallationId,
  user: LiteralUser, host: LiteralHost, port: Port,
  hostKeys: Schema.Array(PublicKey).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(8))),
  juntoHome: MachineAbsolutePath, installRoot: MachineAbsolutePath,
});
export type MachineLinkOpenInput = typeof MachineLinkOpenInput.Type;
export const MachineLinkOpenData = Schema.Struct({ machineName: Name, installationId: InstallationId, boundAt: Schema.String });
export type MachineLinkOpenData = typeof MachineLinkOpenData.Type;

/** On a machine that received links: the key of a machine taken off the canvas comes off. */
export const MachineLinkRevokeInput = Schema.Struct({ installationId: InstallationId });
export type MachineLinkRevokeInput = typeof MachineLinkRevokeInput.Type;
export const MachineLinkRevokeData = Schema.Struct({ installationId: InstallationId, removed: Schema.Boolean });
export type MachineLinkRevokeData = typeof MachineLinkRevokeData.Type;
