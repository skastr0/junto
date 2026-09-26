/**
 * The one-time pairing key: an ed25519 pair, the private half in OpenSSH's own
 * unencrypted format (what the phone's SSH library loads from the QR), the
 * public half as an authorized_keys key. Built in-process from node:crypto so
 * pairing spawns nothing and writes no key file.
 */

import { generateKeyPairSync, randomBytes } from "node:crypto";

export type PairingKeyPair = {
  /** `ssh-ed25519 AAAA...`, no comment. */
  readonly publicKey: string;
  /** `-----BEGIN OPENSSH PRIVATE KEY-----` ... */
  readonly privateKey: string;
};

const u32 = (value: number): Buffer => {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
};

const sshString = (value: Buffer | string): Buffer => {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  return Buffer.concat([u32(bytes.byteLength), bytes]);
};

const fromBase64Url = (value: string): Buffer => Buffer.from(value.replace(/-/gu, "+").replace(/_/gu, "/"), "base64");

/** Encode a raw ed25519 pair (32-byte seed, 32-byte public) as OpenSSH text. */
export const encodeOpenSshEd25519 = (
  seed: Buffer,
  pub: Buffer,
  options: { readonly comment?: string; readonly checkInt?: number } = {},
): PairingKeyPair => {
  if (seed.byteLength !== 32 || pub.byteLength !== 32) throw new Error("ed25519 keys are 32 bytes");
  const keyType = "ssh-ed25519";
  const publicBlob = Buffer.concat([sshString(keyType), sshString(pub)]);
  const check = options.checkInt ?? randomBytes(4).readUInt32BE(0);
  let privateSection = Buffer.concat([
    u32(check),
    u32(check),
    sshString(keyType),
    sshString(pub),
    sshString(Buffer.concat([seed, pub])),
    sshString(options.comment ?? ""),
  ]);
  // Cipher "none" pads to its 8-byte block with 1, 2, 3, ...
  const padding: number[] = [];
  for (let i = 1; (privateSection.byteLength + padding.length) % 8 !== 0; i += 1) padding.push(i);
  privateSection = Buffer.concat([privateSection, Buffer.from(padding)]);

  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "binary"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    u32(1),
    sshString(publicBlob),
    sshString(privateSection),
  ]);
  const wrapped = body.toString("base64").match(/.{1,70}/gu)?.join("\n") ?? "";
  return {
    publicKey: `${keyType} ${publicBlob.toString("base64")}`,
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${wrapped}\n-----END OPENSSH PRIVATE KEY-----\n`,
  };
};

/** A fresh one-time pairing key. */
export const generatePairingKey = (): PairingKeyPair => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "jwk" }).x;
  const seed = privateKey.export({ format: "jwk" }).d;
  if (typeof pub !== "string" || typeof seed !== "string") throw new Error("ed25519 export failed");
  return encodeOpenSshEd25519(fromBase64Url(seed), fromBase64Url(pub));
};
