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
};
