/**
 * authorized_keys editor against fixtures: Junto touches only its own
 * `junto-companion:` lines, writes atomically at 0600, and refuses a symlink.
 * Never the real ~/.ssh: every file here lives in a temp directory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthorizedKeysError,
  companionDeviceOfLine,
  companionDevicesIn,
  companionKeyLine,
  editAuthorizedKeys,
  pruneCompanionKeys,
  removeCompanionKey,
  upsertCompanionKey,
} from "../src/main/junto/companion/authorized-keys";
import { encodeOpenSshEd25519, generatePairingKey } from "../src/main/junto/companion/pairing-key";

const DEV_A = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const DEV_B = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W4";
const KEY_A = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTY=";
const KEY_B = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherKeyForTheSecondPhone";
const JUNTO = "/Applications/Junto.app/Contents/Resources/bin/junto";

/** The operator's own file, with the things a real one has. */
const FIXTURE = [
  "# my keys",
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonalLaptopKey me@laptop",
  "",
  'from="10.0.0.0/8",no-pty ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ work@box',
  "   ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY= indented junto-companion:not-a-device",
].join("\n");

const lineA = companionKeyLine({ juntoPath: JUNTO, deviceId: DEV_A, publicKey: KEY_A });
const lineB = companionKeyLine({ juntoPath: JUNTO, deviceId: DEV_B, publicKey: KEY_B });

describe("companion key lines", () => {
  it("pins the key to companion-stdio with every forwarding off", () => {
    expect(lineA).toBe(
      `command="'${JUNTO}' companion-stdio --device ${DEV_A}",restrict ${KEY_A} junto-companion:${DEV_A}`,
    );
    expect(companionDeviceOfLine(lineA)).toBe(DEV_A);
  });

  it("quotes a path with spaces and refuses one it cannot quote", () => {
    const spaced = companionKeyLine({ juntoPath: "/Users/me/My Apps/junto", deviceId: DEV_A, publicKey: KEY_A });
    expect(spaced).toContain(`command="'/Users/me/My Apps/junto' companion-stdio`);
    for (const juntoPath of ["/a'b/junto", '/a"b/junto', "/a\\b", "relative/junto", "/a\nb"]) {
      expect(() => companionKeyLine({ juntoPath, deviceId: DEV_A, publicKey: KEY_A }), juntoPath).toThrow(
        AuthorizedKeysError,
      );
    }
    expect(() => companionKeyLine({ juntoPath: JUNTO, deviceId: "dev_x", publicKey: KEY_A })).toThrow();
    expect(() =>
      companionKeyLine({ juntoPath: JUNTO, deviceId: DEV_A, publicKey: `${KEY_A} extra` }),
    ).toThrow();
  });

  it("recognizes only its own tag with a real device id", () => {
    expect(companionDevicesIn(FIXTURE)).toEqual([]);
    expect(companionDeviceOfLine(`${KEY_A} junto-companion:${DEV_A} trailing`)).toBeUndefined();
  });
});

describe("pure edits", () => {
  it("appends without gluing to a file that lacks a final newline", () => {
    const next = upsertCompanionKey(FIXTURE, DEV_A, lineA);
    expect(next).toBe(`${FIXTURE}\n${lineA}\n`);
    expect(next.startsWith(FIXTURE)).toBe(true);
  });

  it("replaces a device's line in place and drops a stale duplicate", () => {
    const withBoth = `${FIXTURE}\n${lineA}\n${lineB}\n${lineA}\n`;
    const swapped = companionKeyLine({ juntoPath: JUNTO, deviceId: DEV_A, publicKey: KEY_B });
    const next = upsertCompanionKey(withBoth, DEV_A, swapped);
    expect(next).toBe(`${FIXTURE}\n${swapped}\n${lineB}\n`);
  });

  it("removes only the device's lines and keeps everything else byte for byte", () => {
    const withBoth = `${FIXTURE}\n${lineA}\n${lineB}\n`;
    expect(removeCompanionKey(withBoth, DEV_A)).toBe(`${FIXTURE}\n${lineB}\n`);
    expect(removeCompanionKey(FIXTURE, DEV_A)).toBe(FIXTURE);
    expect(pruneCompanionKeys(withBoth, new Set([DEV_B]))).toBe(`${FIXTURE}\n${lineB}\n`);
    expect(pruneCompanionKeys(withBoth, new Set())).toBe(`${FIXTURE}\n`);
  });

  it("keeps CRLF lines and odd whitespace of other entries intact", () => {
    const crlf = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPersonalLaptopKey me\r\n\t\n";
    expect(removeCompanionKey(upsertCompanionKey(crlf, DEV_A, lineA), DEV_A)).toBe(crlf);
  });
});

describe("the file", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "junto-authkeys-"));
    dirs.push(dir);
    return dir;
  };

  it("creates ~/.ssh at 0700 and the file at 0600", async () => {
    const path = join(home(), ".ssh", "authorized_keys");
    await editAuthorizedKeys((text) => upsertCompanionKey(text, DEV_A, lineA), path);
    expect(readFileSync(path, "utf8")).toBe(`${lineA}\n`);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(path, "..")).mode & 0o777).toBe(0o700);
  });

  it("rewrites atomically, leaves no temp file, and preserves the operator's lines", async () => {
    const root = home();
    const path = join(root, "authorized_keys");
    writeFileSync(path, FIXTURE, { mode: 0o644 });
    await editAuthorizedKeys((text) => upsertCompanionKey(text, DEV_A, lineA), path);
    await editAuthorizedKeys((text) => upsertCompanionKey(text, DEV_B, lineB), path);
    await editAuthorizedKeys((text) => removeCompanionKey(text, DEV_A), path);
    expect(readFileSync(path, "utf8")).toBe(`${FIXTURE}\n${lineB}\n`);
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(root)).toEqual(["authorized_keys"]);
  });

  it("does not rewrite a file the edit leaves unchanged", async () => {
    const path = join(home(), "authorized_keys");
    writeFileSync(path, FIXTURE, { mode: 0o644 });
    await editAuthorizedKeys((text) => removeCompanionKey(text, DEV_A), path);
    expect(lstatSync(path).mode & 0o777).toBe(0o644);
  });

  it("refuses to replace a symlinked authorized_keys", async () => {
    const root = home();
    const target = join(root, "elsewhere");
    writeFileSync(target, FIXTURE);
    const path = join(root, "authorized_keys");
    symlinkSync(target, path);
    await expect(editAuthorizedKeys((text) => upsertCompanionKey(text, DEV_A, lineA), path)).rejects.toMatchObject({
      reason: "symlink",
    });
    expect(readFileSync(target, "utf8")).toBe(FIXTURE);
  });

  it("serializes concurrent edits so none is lost", async () => {
    const path = join(home(), "authorized_keys");
    await Promise.all([
      editAuthorizedKeys((text) => upsertCompanionKey(text, DEV_A, lineA), path),
      editAuthorizedKeys((text) => upsertCompanionKey(text, DEV_B, lineB), path),
    ]);
    expect(companionDevicesIn(readFileSync(path, "utf8"))).toEqual([DEV_A, DEV_B]);
  });
});

describe("pairing key", () => {
  it("encodes a known ed25519 pair deterministically", () => {
    const seed = Buffer.alloc(32, 1);
    const pub = Buffer.alloc(32, 2);
    const pair = encodeOpenSshEd25519(seed, pub, { checkInt: 0x01020304 });
    expect(pair.publicKey).toBe(
      `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), pub]).toString("base64")}`,
    );
    expect(pair.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----\n")).toBe(true);
    expect(pair.privateKey.endsWith("\n-----END OPENSSH PRIVATE KEY-----\n")).toBe(true);
  });

  const sshKeygen = "/usr/bin/ssh-keygen";
  it.runIf(existsSync(sshKeygen))("produces a private key OpenSSH itself loads, matching its public half", () => {
    const pair = generatePairingKey();
    const dir = mkdtempSync(join(tmpdir(), "junto-pairkey-"));
    const file = join(dir, "pairing");
    writeFileSync(file, pair.privateKey, { mode: 0o600 });
    const derived = execFileSync(sshKeygen, ["-y", "-f", file], { encoding: "utf8" }).trim();
    expect(derived.split(" ").slice(0, 2).join(" ")).toBe(pair.publicKey);
    // And the public half is a key a companion line accepts.
    expect(() => companionKeyLine({ juntoPath: JUNTO, deviceId: DEV_A, publicKey: pair.publicKey })).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
