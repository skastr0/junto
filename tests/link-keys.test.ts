/**
 * Link keys (src/core/link/link-keys.ts): every authorized_keys and
 * known_hosts line is built from typed fields, so no input can open an
 * unrestricted line or accept a host it should not.
 */
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
  hasLinkLine, linkHomeTag, linkKeyLine, linkLineOwner, makeLinkKey, readBoundRoute, removeLinkLines,
  upsertLinkLine, verifiedHostKeys, writeBoundRoute, writeLinkKnownHosts,
} from "../src/core/link/link-keys";
import { generatePairingKey } from "../src/core/companion/pairing-key";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const root = async (): Promise<string> => { const made = await mkdtemp(join(tmpdir(), "junto-link-keys-")); roots.push(made); return made; };

const KEY = generatePairingKey().publicKey;
const OTHER = generatePairingKey().publicKey;
const HOME = "/home/ops/junto-home";
const JUNTO = "/home/ops/.local/junto/current/bin/junto";
const line = (overrides: Partial<Parameters<typeof linkKeyLine>[0]> = {}) =>
  linkKeyLine({ juntoHome: HOME, juntoPath: JUNTO, opener: "mini-installation", publicKey: KEY, ...overrides });

describe("the authorized_keys line", () => {
  it("lets the key run only junto link bound to its opener, restricted, and names its home and opener", () => {
    const written = line();
    expect(written).toBe(`command="/usr/bin/env JUNTO_HOME='${HOME}' '${JUNTO}' link --opener mini-installation",restrict ${KEY} junto-link:${linkHomeTag(HOME)}:mini-installation`);
    expect(linkLineOwner(written)).toEqual({ home: linkHomeTag(HOME), opener: "mini-installation" });
  });

  it.each([
    ["a quote", 'mini"installation'],
    ["a single quote", "mini'installation"],
    ["a newline", "mini\ninstallation"],
    ["an options prefix", 'x",no-restrict,command="/bin/sh'],
    ["a space and a second key", `mini ${OTHER}`],
  ])("refuses an opener id with %s", (_what, opener) => {
    expect(() => line({ opener })).toThrow(/installation id/);
  });

  it.each([
    ["a quote", `${KEY}"`],
    ["a newline and a second key", `${KEY}\n${OTHER}`],
    ["an options prefix", `command="/bin/sh" ${KEY}`],
    ["a second key", `${KEY} ${OTHER}`],
    ["an ecdsa key", "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBA=="],
    ["an ed25519 type over another blob", `ssh-ed25519 ${Buffer.from("not a key blob at all, padded out").toString("base64")}`],
  ])("refuses a public key with %s", (_what, publicKey) => {
    expect(() => line({ publicKey })).toThrow(/ssh-ed25519/);
  });

  it.each([["a quote", "/home/ops/it's"], ["a double quote", '/home/"ops'], ["a newline", "/home/ops\n/x"], ["a relative path", "home/ops"]])(
    "refuses a junto path with %s", (_what, juntoPath) => {
      expect(() => line({ juntoPath })).toThrow(/quoted safely/);
    });

  it("replaces only its own line and keeps every other byte, a missing final newline included", () => {
    const theirs = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorKeyOperatorKeyOperatorKeyOper operator@laptop\n# a comment\n\nssh-rsa AAAAB3 other";
    const once = upsertLinkLine(theirs, line());
    expect(once).toBe(`${theirs}\n${line()}\n`);
    const replaced = upsertLinkLine(once, line({ publicKey: OTHER }));
    expect(replaced).toBe(`${theirs}\n${line({ publicKey: OTHER })}\n`);
    // Another home on the same account keeps its own line for the same opener.
    const both = upsertLinkLine(replaced, line({ juntoHome: "/home/ops/exercise-home" }));
    expect(hasLinkLine(both, linkHomeTag(HOME), "mini-installation")).toBe(true);
    expect(removeLinkLines(both, linkHomeTag(HOME), "mini-installation")).toBe(`${theirs}\n${line({ juntoHome: "/home/ops/exercise-home" })}\n`);
    expect(removeLinkLines(both, linkHomeTag("/home/ops/exercise-home"))).toBe(`${theirs}\n${line({ publicKey: OTHER })}\n`);
  });

  it("never claims an operator line that only mentions the tag mid-line", () => {
    expect(linkLineOwner(`ssh-ed25519 AAAA junto-link:${linkHomeTag(HOME)}:mini then more`)).toBeUndefined();
  });
});

describe("the key that dials", () => {
  it("is made once, 0600, with its opener in the comment, and refuses an existing key unless replaced", async () => {
    const home = await root();
    const pub = makeLinkKey(home, "vps", "mini-installation");
    expect(pub).toMatch(/^ssh-ed25519 /);
    const file = join(home, ".junto/core/link-keys/vps/id_ed25519");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, ".junto/core/link-keys/vps"))).mode & 0o777).toBe(0o700);
    expect(await readFile(`${file}.pub`, "utf8")).toBe(`${pub} junto-link:mini-installation\n`);
    expect(() => makeLinkKey(home, "vps", "mini-installation")).toThrow(/already exists/);
    const again = makeLinkKey(home, "vps", "mini-installation", { replace: true });
    expect(again).not.toBe(pub);
  });

  it("refuses a peer name that is a path", async () => {
    const home = await root();
    expect(() => makeLinkKey(home, "../vps", "mini-installation")).toThrow(/machine name/);
  });

  it("writes its own known_hosts, one literal host and no markers, and reads its route back", async () => {
    const home = await root();
    makeLinkKey(home, "vps", "mini-installation");
    const route = { user: "ops", host: "vps.tailnet.ts.net", port: 2222 };
    const knownHostsFile = writeLinkKnownHosts(home, "vps", route, [KEY]);
    expect(await readFile(knownHostsFile, "utf8")).toBe(`[vps.tailnet.ts.net]:2222 ${KEY}\n`);
    // Known hosts alone do not bind the link: the route goes live only once it is written.
    expect(readBoundRoute(home, "vps")).toBeUndefined();
    const files = writeBoundRoute(home, "vps", route);
    expect(files.knownHostsFile).toBe(knownHostsFile);
    expect(readBoundRoute(home, "vps")).toEqual(files);
  });

  it.each([
    ["a host pattern", { user: "ops", host: "*.ts.net", port: 22 }],
    ["a host list", { user: "ops", host: "a,b", port: 22 }],
    ["a host with a newline", { user: "ops", host: "vps\n@cert-authority *", port: 22 }],
    ["a user with an at sign", { user: "ops@x", host: "vps", port: 22 }],
    ["a port out of range", { user: "ops", host: "vps", port: 70_000 }],
    ["an IPv6 address in brackets", { user: "ops", host: "[2001:db8::1]", port: 22 }],
    ["an IPv6 zone", { user: "ops", host: "fe80::1%en0", port: 22 }],
    ["an IPv4-mapped IPv6 address", { user: "ops", host: "::ffff:203.0.113.7", port: 22 }],
    ["the unspecified address", { user: "ops", host: "::", port: 22 }],
    ["a multicast address", { user: "ops", host: "ff02::1", port: 22 }],
    ["a link-local address", { user: "ops", host: "fe80::1", port: 22 }],
  ])("refuses a route with %s", async (_what, route) => {
    const home = await root();
    makeLinkKey(home, "vps", "mini-installation");
    expect(() => writeLinkKnownHosts(home, "vps", route, [KEY])).toThrow(/literal user, host and port/);
    expect(() => writeBoundRoute(home, "vps", route)).toThrow(/literal user, host and port/);
  });

  it("stores an IPv6 route in RFC 5952 text and writes the two known_hosts forms", async () => {
    const home = await root();
    makeLinkKey(home, "vps", "mini-installation");
    const route = { user: "ops", host: "2001:0DB8:0000:0000:0000:0000:0000:0001", port: 22 };
    const knownHosts = writeLinkKnownHosts(home, "vps", route, [KEY]);
    expect(await readFile(knownHosts, "utf8")).toBe(`2001:db8::1 ${KEY}\n`);
    const files = writeBoundRoute(home, "vps", route);
    expect(await readFile(join(home, ".junto/core/link-keys/vps/route.json"), "utf8")).toBe(`${JSON.stringify({ user: "ops", host: "2001:db8::1", port: 22 })}\n`);
    expect(readBoundRoute(home, "vps")).toEqual(files);
    const otherPort = writeLinkKnownHosts(home, "vps", { ...route, port: 2222 }, [KEY]);
    expect(await readFile(otherPort, "utf8")).toBe(`[2001:db8::1]:2222 ${KEY}\n`);
  });

  it("canonicalizes an IPv6 spelling already in route.json", async () => {
    const home = await root();
    makeLinkKey(home, "vps", "mini-installation");
    writeLinkKnownHosts(home, "vps", { user: "ops", host: "2001:0db8::1", port: 22 }, [KEY]);
    await writeFile(join(home, ".junto/core/link-keys/vps/route.json"), `${JSON.stringify({ user: "ops", host: "2001:0DB8::1", port: 22 })}\n`);
    expect(readBoundRoute(home, "vps")).toMatchObject({ user: "ops", host: "2001:db8::1", port: 22 });
  });

  it("looks up a verified IPv6 host key under its canonical names, default port and not", async () => {
    const file = join(await root(), "known_hosts");
    await writeFile(file, `2001:db8::1 ${KEY}\n[2001:db8::1]:2222 ${KEY}\n`);
    expect(verifiedHostKeys([file], "2001:0DB8::1", 22)).toEqual([KEY]);
    expect(verifiedHostKeys([file], "2001:db8::1", 2222)).toEqual([KEY]);
  });

  it.each([["a second key on the line", `${KEY} ${OTHER}`], ["a newline", `${KEY}\n* ${OTHER}`], ["an rsa key", "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQ"]])(
    "refuses a host key with %s", async (_what, hostKey) => {
      const home = await root();
      makeLinkKey(home, "vps", "mini-installation");
      expect(() => writeLinkKnownHosts(home, "vps", { user: "ops", host: "vps", port: 22 }, [hostKey])).toThrow(/ssh-ed25519/);
    });
});

describe("the host key the setup session verified", () => {
  const hashed = (name: string): string => {
    const salt = randomBytes(20);
    return `|1|${salt.toString("base64")}|${createHmac("sha1", salt).update(name).digest("base64")}`;
  };

  it("finds exact and hashed entries for the literal host and port, and nothing for a pattern", async () => {
    const dir = await root();
    const file = join(dir, "known_hosts");
    await writeFile(file, [
      `100.96.152.41 ${KEY}`,
      `${hashed("[vps.example]:2222")} ${OTHER}`,
      `*.example ${generatePairingKey().publicKey}`,
      `mac-mini,other ssh-rsa AAAAB3NzaC1yc2E`,
      "",
    ].join("\n"));
    expect(verifiedHostKeys([file], "100.96.152.41", 22)).toEqual([KEY]);
    expect(verifiedHostKeys([file, join(dir, "absent")], "vps.example", 2222)).toEqual([OTHER]);
    expect(() => verifiedHostKeys([file], "a.example", 22)).toThrow(/No ed25519 host key/);
  });

  it("refuses a host whose key is revoked", async () => {
    const file = join(await root(), "known_hosts");
    await writeFile(file, `vps ${KEY}\n@revoked vps ${KEY}\n`);
    expect(() => verifiedHostKeys([file], "vps", 22)).toThrow(/revoked/);
  });
});
