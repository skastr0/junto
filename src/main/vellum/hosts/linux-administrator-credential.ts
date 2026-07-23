/**
 * One-shot in-memory authority for one Linux administrator ceremony.
 *
 * The renderer-facing password string is unavoidably resident while Electron
 * crosses IPC. Main immediately converts it into this opaque capability. The
 * capability has no serializable fields, never exposes the password before
 * its exact deployment binding matches, and may be consumed only once.
 */

import { timingSafeEqual } from "node:crypto";
import type { SshEndpoint } from "../ssh";

const HOST_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const ENDPOINT = /^(?!-)[A-Za-z0-9._:@%+\[\]-]+$/u;
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const MAX_PASSWORD_BYTES = 256;

export interface LinuxAdministratorCredentialBinding {
  readonly hostId: string;
  readonly endpoint: SshEndpoint;
  readonly version: string;
  readonly manifestSha256: string;
  readonly debSha256: string;
  readonly inventorySha256: string;
}

declare const LinuxAdministratorCredentialTypeId: unique symbol;

export interface LinuxAdministratorCredential {
  readonly [LinuxAdministratorCredentialTypeId]: typeof LinuxAdministratorCredentialTypeId;
}

interface CredentialState {
  readonly binding: LinuxAdministratorCredentialBinding;
  readonly passwordLine: Buffer;
}

const credentials = new WeakMap<LinuxAdministratorCredential, CredentialState>();

const validBinding = (binding: LinuxAdministratorCredentialBinding): boolean =>
  HOST_ID.test(binding.hostId) &&
  typeof binding.endpoint === "string" &&
  ENDPOINT.test(binding.endpoint) &&
  Buffer.byteLength(binding.endpoint, "utf8") <= 255 &&
  VERSION.test(binding.version) &&
  SHA256.test(binding.manifestSha256) &&
  SHA256.test(binding.debSha256) &&
  SHA256.test(binding.inventorySha256);

const encodedBinding = (binding: LinuxAdministratorCredentialBinding): Buffer =>
  Buffer.from(
    [
      binding.hostId,
      binding.endpoint,
      binding.version,
      binding.manifestSha256,
      binding.debSha256,
      binding.inventorySha256,
    ].join("\n"),
    "utf8",
  );

const bindingsEqual = (
  left: LinuxAdministratorCredentialBinding,
  right: LinuxAdministratorCredentialBinding,
): boolean => {
  const leftBytes = encodedBinding(left);
  const rightBytes = encodedBinding(right);
  try {
    return (
      leftBytes.byteLength === rightBytes.byteLength &&
      timingSafeEqual(leftBytes, rightBytes)
    );
  } finally {
    leftBytes.fill(0);
    rightBytes.fill(0);
  }
};

const stateOf = (
  credential: LinuxAdministratorCredential,
): CredentialState | undefined => credentials.get(credential);

export const mintLinuxAdministratorCredential = (
  password: unknown,
  binding: LinuxAdministratorCredentialBinding,
): LinuxAdministratorCredential => {
  if (!validBinding(binding)) {
    throw new Error("Linux administrator authorization binding is invalid");
  }
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > MAX_PASSWORD_BYTES ||
    password.includes("\0") ||
    password.includes("\r") ||
    password.includes("\n") ||
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES
  ) {
    throw new Error("Linux administrator credential is invalid");
  }
  const encoded = Buffer.from(password, "utf8");
  if (encoded.byteLength === 0) {
    encoded.fill(0);
    throw new Error("Linux administrator credential is invalid");
  }
  const passwordLine = Buffer.allocUnsafe(encoded.byteLength + 1);
  encoded.copy(passwordLine);
  passwordLine[encoded.byteLength] = 0x0a;
  encoded.fill(0);

  const credential = Object.freeze({}) as LinuxAdministratorCredential;
  credentials.set(credential, {
    binding: Object.freeze({ ...binding }),
    passwordLine,
  });
  return credential;
};

export const linuxAdministratorCredentialMatches = (
  credential: LinuxAdministratorCredential | undefined,
  binding: LinuxAdministratorCredentialBinding,
): boolean => {
  const state = credential === undefined ? undefined : stateOf(credential);
  return (
    state !== undefined &&
    validBinding(binding) &&
    bindingsEqual(state.binding, binding)
  );
};

/**
 * Consume the exact password line after the package-owned bridge emitted its
 * bound AUTH_ARMED record. Ownership of the returned Buffer transfers to the
 * caller, which must zero it immediately after the single SSH write settles.
 */
export const takeLinuxAdministratorPasswordLine = (
  credential: LinuxAdministratorCredential,
  binding: LinuxAdministratorCredentialBinding,
): Buffer => {
  const state = stateOf(credential);
  if (state === undefined) {
    throw new Error("Linux administrator credential is unavailable");
  }
  credentials.delete(credential);
  if (!validBinding(binding) || !bindingsEqual(state.binding, binding)) {
    state.passwordLine.fill(0);
    throw new Error("Linux administrator authorization binding changed");
  }
  return state.passwordLine;
};

/** Best-effort zeroization for every path that ends before AUTH_ARMED. */
export const destroyLinuxAdministratorCredential = (
  credential: LinuxAdministratorCredential | undefined,
): void => {
  if (credential === undefined) return;
  const state = stateOf(credential);
  credentials.delete(credential);
  state?.passwordLine.fill(0);
};
