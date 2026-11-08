/**
 * Paired phones for the companion (docs/companion-protocol.md, section 6): one
 * row per device, added by state migration 5 -> 6.
 *
 * A device is `pairing` from the moment Settings shows its QR (the key is the
 * one-time pairing key, and `pairing_expires_at` bounds it) until the phone
 * completes pairing, when the key becomes the phone's own and the device is
 * `paired`. Remove deletes the row; there is no revoked state to keep.
 */
export const COMPANION_DEVICES_STATE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS companion_devices (
    device_id TEXT PRIMARY KEY
      CHECK (length(device_id) = 30 AND substr(device_id, 1, 4) = 'dev_'),
    name TEXT NOT NULL CHECK (length(name) <= 100),
    state TEXT NOT NULL CHECK (state IN ('pairing', 'paired')),
    public_key TEXT NOT NULL CHECK (length(public_key) BETWEEN 1 AND 2048),
    pairing_expires_at INTEGER
      CHECK (pairing_expires_at IS NULL OR pairing_expires_at >= 0),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    paired_at INTEGER CHECK (paired_at IS NULL OR paired_at >= 0),
    last_seen_at INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= 0),
    CHECK ((state = 'pairing') = (pairing_expires_at IS NOT NULL)),
    CHECK ((state = 'paired') = (paired_at IS NOT NULL))
  ) STRICT, WITHOUT ROWID;
`;
