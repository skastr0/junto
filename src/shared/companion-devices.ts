import { Schema } from "effect";

/**
 * A paired (or pairing) phone as Settings shows it. The key itself stays in
 * main and authorized_keys; nothing here is a secret.
 */
export const CompanionDeviceRecord = Schema.Struct({
  deviceId: Schema.String,
  name: Schema.String,
  state: Schema.Literals(["pairing", "paired"]),
  createdAt: Schema.Number,
  pairedAt: Schema.optionalKey(Schema.Number),
  lastSeenAt: Schema.optionalKey(Schema.Number),
  pairingExpiresAt: Schema.optionalKey(Schema.Number),
  /**
   * A paired phone whose line is gone from authorized_keys: `missing` may be
   * restored from Settings, `damaged` (its stored key is unusable) only
   * removed. Absent: the line is there, or the phone is still pairing.
   */
  key: Schema.optionalKey(Schema.Literals(["missing", "damaged"])),
});
export type CompanionDeviceRecord = typeof CompanionDeviceRecord.Type;

/**
 * Why a phone's key could not be restored or removed; the closed list logs
 * carry. `junto-path`: the junto command's path cannot be written into a
 * forced command, which says nothing about the phone's key.
 */
export const CompanionKeyFailure = Schema.Literals(["missing", "damaged", "symlink", "io", "junto-path"]);
export type CompanionKeyFailure = typeof CompanionKeyFailure.Type;

/** Restore or Restore all, clicked in Settings, Companion. */
export const CompanionKeyRestore = Schema.Struct({
  ok: Schema.Boolean,
  restored: Schema.Array(Schema.String),
  failed: Schema.Array(Schema.Struct({ deviceId: Schema.String, reason: CompanionKeyFailure })),
  message: Schema.optionalKey(Schema.String),
});
export type CompanionKeyRestore = typeof CompanionKeyRestore.Type;

/** What Settings, Companion shows about this Mac's readiness to pair. */
export const CompanionStatus = Schema.Struct({
  /** False on a Remote station: phones pair with the Command Center. */
  available: Schema.Boolean,
  remoteLogin: Schema.Literals(["on", "off"]),
  tailscale: Schema.optionalKey(Schema.Struct({
    name: Schema.optionalKey(Schema.String),
    address: Schema.optionalKey(Schema.String),
  })),
  /** Where a phone will look for this Mac, in order. */
  hosts: Schema.Array(Schema.String),
  juntoCommand: Schema.Boolean,
  hostKey: Schema.Boolean,
  station: Schema.String,
});
export type CompanionStatus = typeof CompanionStatus.Type;

export const CompanionPairStart = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    deviceId: Schema.String,
    expiresAt: Schema.Number,
    /** A self-contained SVG. It carries a one-time key: show it, never store it. */
    qrSvg: Schema.String,
    hosts: Schema.Array(Schema.String),
  }),
  Schema.Struct({ ok: Schema.Literal(false), message: Schema.String }),
]);
export type CompanionPairStart = typeof CompanionPairStart.Type;

/** Remove, clicked in Settings, Companion: whether the phone is gone, and why not when it is not. */
export const CompanionRemoval = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.optionalKey(Schema.String),
});
export type CompanionRemoval = typeof CompanionRemoval.Type;
