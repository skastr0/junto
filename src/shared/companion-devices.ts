/**
 * A paired (or pairing) phone as Settings shows it. The key itself stays in
 * main and authorized_keys; nothing here is a secret.
 */
export type CompanionDeviceRecord = {
  readonly deviceId: string;
  readonly name: string;
  readonly state: "pairing" | "paired";
  readonly createdAt: number;
  readonly pairedAt?: number;
  readonly lastSeenAt?: number;
  readonly pairingExpiresAt?: number;
  /**
   * A paired phone whose line is gone from authorized_keys: `missing` may be
   * restored from Settings, `damaged` (its stored key is unusable) only
   * removed. Absent: the line is there, or the phone is still pairing.
   */
  readonly key?: "missing" | "damaged";
};

/**
 * Why a phone's key could not be restored or removed; the closed list logs
 * carry. `junto-path`: the junto command's path cannot be written into a
 * forced command, which says nothing about the phone's key.
 */
export type CompanionKeyFailure = "missing" | "damaged" | "symlink" | "io" | "junto-path";

/** Restore or Restore all, clicked in Settings, Companion. */
export type CompanionKeyRestore = {
  readonly ok: boolean;
  readonly restored: ReadonlyArray<string>;
  readonly failed: ReadonlyArray<{ readonly deviceId: string; readonly reason: CompanionKeyFailure }>;
  readonly message?: string;
};

/** What Settings, Companion shows about this Mac's readiness to pair. */
export type CompanionStatus = {
  /** False on a Remote station: phones pair with the Command Center. */
  readonly available: boolean;
  readonly remoteLogin: "on" | "off";
  readonly tailscale?: { readonly name?: string; readonly address?: string };
  /** Where a phone will look for this Mac, in order. */
  readonly hosts: ReadonlyArray<string>;
  readonly juntoCommand: boolean;
  readonly hostKey: boolean;
  readonly station: string;
};

export type CompanionPairStart =
  | {
      readonly ok: true;
      readonly deviceId: string;
      readonly expiresAt: number;
      /** A self-contained SVG. It carries a one-time key: show it, never store it. */
      readonly qrSvg: string;
      readonly hosts: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly message: string };
