/**
 * Boat (boat.dev) machines: the shapes Junto keeps and reads about a sandbox
 * (docs/machines.md, Boat machines). No key value is ever part of these.
 */
import { Schema } from "effect";
import { isValidMachineName } from "./machine-identity";

/** Boat's sandbox id, as its API writes it. */
export const BoatSandboxId = Schema.String.pipe(Schema.check(Schema.isPattern(/^bx_[a-z0-9]{4,32}$/)));
export type BoatSandboxId = typeof BoatSandboxId.Type;

export const BoatSize = Schema.Literals(["small", "default", "large"]);
export type BoatSize = typeof BoatSize.Type;

/** A Boat environment the operator named; Junto never picks one. */
export const BoatEnvironmentName = Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)));

/** Boat's id for a key: listed and revoked by it, never a secret. */
export const BoatKeyId = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f-]{8,64}$/)));
export type BoatKeyId = typeof BoatKeyId.Type;

/** What the machine list keeps for a machine Junto created on Boat. */
export const BoatMachine = Schema.Struct({
  sandboxId: BoatSandboxId,
  size: BoatSize,
  /** The key limited to this sandbox, on the machine itself. */
  machineKeyId: Schema.optionalKey(BoatKeyId),
});
export type BoatMachine = typeof BoatMachine.Type;

/** The lease: a Boat machine always runs with this time limit. */
export const BOAT_LEASE_SECONDS = 20 * 60;
/** How often a busy machine renews its lease. */
export const BOAT_LEASE_RENEW_MS = 5 * 60_000;
/** A machine with no seat working and no terminal bytes for this long lets its lease end. */
export const BOAT_IDLE_MS = 15 * 60_000;
/** Boat deletes a stopped disk after 14 days; Junto wakes a machine asleep this long. */
export const BOAT_KEEP_DISK_AFTER_MS = 12 * 24 * 60 * 60_000;

/** The account key's actions, exactly. */
export const BOAT_ACCOUNT_KEY_ACTIONS = [
  "sandbox.create", "sandbox.read", "sandbox.update", "sandbox.stop", "sandbox.resume", "sandbox.delete-own", "ssh",
] as const;
/** A machine key's actions, on its own sandbox only. */
export const BOAT_MACHINE_KEY_ACTIONS = ["sandbox.read", "sandbox.update", "sandbox.stop"] as const;

/** Where a Boat machine stands, in Junto's words. */
export const BoatPower = Schema.Literals(["awake", "waking", "asleep", "falling-asleep", "failed", "gone"]);
export type BoatPower = typeof BoatPower.Type;

/** Boat's sandbox states, read into Junto's. An unknown state is `failed`, never `awake`. */
export const boatPower = (state: string): BoatPower => {
  switch (state) {
    case "ready": case "idle": case "running": return "awake";
    case "init": case "provisioning": case "provisioned": case "cloning": case "starting": case "resuming": return "waking";
    case "archived": case "stopped": return "asleep";
    case "archiving": case "stopping": return "falling-asleep";
    case "cancelled": case "deleted": return "gone";
    default: return "failed";
  }
};

/**
 * A Boat key's value: `boat_` (or the older `box_`) then base64url. Measured:
 * a minted key may carry "-", so the alphabet is [A-Za-z0-9_-]. The scrubber's
 * BOAT_KEY uses the same alphabet, so no tail of a key outlives a redaction.
 */
export const BoatKeySecret = Schema.String.pipe(Schema.check(Schema.isPattern(/^(?:boat|box)_[A-Za-z0-9_-]{24,256}$/)));

// --- Owner commands -----------------------------------------------------------

const BoatMachineName = Schema.String.pipe(Schema.check(Schema.makeFilter(isValidMachineName)));
const When = Schema.String.pipe(Schema.check(Schema.isMaxLength(64)));

/** A Boat machine as the owner reads it. */
export const BoatMachineView = Schema.Struct({
  machineName: BoatMachineName,
  sandboxId: BoatSandboxId,
  size: BoatSize,
  power: BoatPower,
  /** When Boat stops it unless the lease is renewed. */
  deadline: Schema.optionalKey(When),
  asleepSince: Schema.optionalKey(When),
  /** Boat deletes a stopped disk 14 days after the stop. */
  diskKeptUntil: Schema.optionalKey(When),
});
export type BoatMachineView = typeof BoatMachineView.Type;

export const BoatConnectData = Schema.Struct({
  connected: Schema.Literal(true),
  keyId: BoatKeyId,
  expiresAt: Schema.optionalKey(When),
  /** The key this one replaced, when its revocation failed. */
  unrevokedKeyIds: Schema.Array(BoatKeyId).pipe(Schema.check(Schema.isMaxLength(16))),
});
export type BoatConnectData = typeof BoatConnectData.Type;

export const BoatDisconnectData = Schema.Struct({
  connected: Schema.Literal(false),
  unrevokedKeyIds: Schema.Array(BoatKeyId).pipe(Schema.check(Schema.isMaxLength(16))),
});
export type BoatDisconnectData = typeof BoatDisconnectData.Type;

export const BoatStatusData = Schema.Struct({
  connected: Schema.Boolean,
  keyId: Schema.optionalKey(BoatKeyId),
  expiresAt: Schema.optionalKey(When),
  /** Keys whose revocation failed, so the operator can revoke them. */
  unrevokedKeyIds: Schema.Array(BoatKeyId).pipe(Schema.check(Schema.isMaxLength(64))),
  machines: Schema.Array(Schema.Struct({
    ...BoatMachineView.fields,
    /** Set when Boat could not be asked about it. */
    unreadable: Schema.optionalKey(Schema.Literal(true)),
  })).pipe(Schema.check(Schema.isMaxLength(32))),
});
export type BoatStatusData = typeof BoatStatusData.Type;

export const BoatAddInput = Schema.Struct({
  name: BoatMachineName,
  label: Schema.optionalKey(Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(64)))),
  size: Schema.optionalKey(BoatSize),
  /** One of the operator's own Boat environments; without it, none of the account's stored secrets. */
  environment: Schema.optionalKey(BoatEnvironmentName),
});
export type BoatAddInput = typeof BoatAddInput.Type;

/** What `junto machine boat-key-local` reads on stdin over the dialled SSH session. */
export const BoatMachineKeyDelivery = Schema.Struct({
  sandboxId: BoatSandboxId,
  keyId: BoatKeyId,
  key: BoatKeySecret,
});
