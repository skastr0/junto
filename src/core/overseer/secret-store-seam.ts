import { regionSecrets } from "../region-env/secret-store";

/**
 * The seam to Junto's own secret store on this machine.
 *
 * The overseer's `secret.*` operations save, remove and list. They never
 * read: this type has no way to return a value, so no operation can, even
 * though the store behind it reads for the launch resolver.
 */
export type OverseerSecretStore = {
  /** Which store is active on this machine, by name. */
  readonly backend: string;
  /** With `secretId` the value behind it is replaced; without, an id is minted. */
  readonly save: (input: {
    readonly value: string;
    readonly secretId?: string;
  }) =>
    | { readonly ok: true; readonly secretId: string }
    /** Plain words. Never contains the value. */
    | { readonly ok: false; readonly message: string };
  readonly remove: (secretId: string) =>
    | { readonly ok: true }
    | { readonly ok: false; readonly message: string };
  /** Ids only. */
  readonly list: () => ReadonlyArray<string>;
};

export const overseerSecretStore = (): OverseerSecretStore | undefined => {
  const { backend, save, remove, list } = regionSecrets();
  return { backend, save, remove, list };
};
