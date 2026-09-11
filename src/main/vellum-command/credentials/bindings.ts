import type { StateReader, StateWriter } from "../state/service";
import type { ProviderCredentialSlot } from "./slots";
import { isProviderCredentialSlot } from "./slots";

export type CredentialLifecycle = "staged" | "active" | "delete_pending";

export type ProviderCredentialBinding = {
  readonly credentialId: string;
  readonly slot: ProviderCredentialSlot;
  readonly lifecycle: CredentialLifecycle;
  readonly createdAt: string;
};

type BindingRow = {
  readonly credential_id: string;
  readonly slot: string;
  readonly lifecycle: string;
  readonly created_at: string;
};

const SELECT_ALL = `
  SELECT credential_id, slot, lifecycle, created_at
  FROM provider_credential_bindings
`;

const decodeRow = (row: BindingRow): ProviderCredentialBinding | undefined => {
  if (!isProviderCredentialSlot(row.slot)) return undefined;
  if (
    row.lifecycle !== "staged" &&
    row.lifecycle !== "active" &&
    row.lifecycle !== "delete_pending"
  ) {
    return undefined;
  }
  return {
    credentialId: String(row.credential_id),
    slot: row.slot,
    lifecycle: row.lifecycle,
    createdAt: String(row.created_at),
  };
};

export const listCredentialBindings = (
  reader: StateReader,
): ReadonlyArray<ProviderCredentialBinding> =>
  reader
    .all<BindingRow>(SELECT_ALL)
    .flatMap((row) => {
      const decoded = decodeRow(row);
      return decoded === undefined ? [] : [decoded];
    });

export const activeBindingForSlot = (
  reader: StateReader,
  slot: ProviderCredentialSlot,
): ProviderCredentialBinding | undefined =>
  listCredentialBindings(reader).find(
    (binding) => binding.slot === slot && binding.lifecycle === "active",
  );

export const insertBinding = (
  writer: StateWriter,
  binding: ProviderCredentialBinding,
): void => {
  writer.run(
    `
      INSERT INTO provider_credential_bindings(
        credential_id, slot, lifecycle, created_at
      ) VALUES (?, ?, ?, ?)
    `,
    [binding.credentialId, binding.slot, binding.lifecycle, binding.createdAt],
  );
};

export const setBindingLifecycle = (
  writer: StateWriter,
  credentialId: string,
  lifecycle: CredentialLifecycle,
): void => {
  writer.run(
    `
      UPDATE provider_credential_bindings
      SET lifecycle = ?
      WHERE credential_id = ?
    `,
    [lifecycle, credentialId],
  );
};

export const deleteBinding = (
  writer: StateWriter,
  credentialId: string,
): void => {
  writer.run(
    `
      DELETE FROM provider_credential_bindings
      WHERE credential_id = ?
    `,
    [credentialId],
  );
};
