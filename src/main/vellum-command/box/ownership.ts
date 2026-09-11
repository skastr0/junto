import type { BoxId, BoxMachine } from "./domain";

declare const OwnedBoxTypeId: unique symbol;

/** Opaque authority proving that this exact Box is recorded in Vellum Command state. */
export interface OwnedBox {
  readonly [OwnedBoxTypeId]: typeof OwnedBoxTypeId;
}

export interface OwnedBoxRecord {
  readonly machine: BoxMachine;
  readonly hostId?: string;
  readonly enrolledAt: string;
  readonly sshPreparedAt?: string;
  readonly sshVerifiedAt?: string;
}

const authority = new WeakMap<OwnedBox, OwnedBoxRecord>();

/** @internal Repository-backed admission only; never export from the Box barrel. */
export const admitOwnedBox = (record: OwnedBoxRecord): OwnedBox => {
  const handle = Object.freeze({}) as OwnedBox;
  authority.set(handle, record);
  return handle;
};

export const inspectOwnedBox = (handle: OwnedBox): OwnedBoxRecord => {
  const record = authority.get(handle);
  if (record === undefined) {
    throw new TypeError("Box lifecycle authority is not repository-backed");
  }
  return record;
};

export const ownedBoxId = (handle: OwnedBox): BoxId =>
  inspectOwnedBox(handle).machine.id;
