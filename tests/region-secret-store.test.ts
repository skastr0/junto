/**
 * Junto's own secret store on the platform's store: macOS Keychain through
 * `security`, Linux Secret Service through `secret-tool`, owner-only files
 * as the fallback. Every backend here runs against a scripted tool and a
 * temp folder. Nothing touches a real Keychain or keyring.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JUNTO_SECRET_SERVICE,
  KeychainCredentialStore,
  MemoryCredentialStore,
  SecretServiceCredentialStore,
  openPlatformSecretStore,
  type SecretToolExec,
} from "../src/main/junto/credentials/store";
import { redactSecretValues } from "../src/main/junto/credentials/redact";
import { makeRegionSecrets } from "../src/main/junto/region-env/secret-store";
import { SECRET_VALUE_MAX_BYTES, secretValueProblem } from "../src/shared/region-secrets";

const ID = "0b6f4c1e-2f0a-4c55-9d3e-6a1f1f0c9a11";
const VALUE = "ops_fake-service-account-token-value";

type Call = { command: string; args: string[]; input?: string };
let directory: string;
let calls: Call[];

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "junto-secret-store-"));
  calls = [];
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

const done = (status: number, stdout = "") => ({ status, stdout, notInstalled: false, timedOut: false });

/** A Keychain that keeps generic passwords in a map, driven the way `security` is. */
const fakeSecurity = (items = new Map<string, string>()): SecretToolExec => (command, args, options) => {
  calls.push({ command, args: [...args], ...(options.input ? { input: options.input } : {}) });
  if (command !== "/usr/bin/security") return { status: undefined, stdout: "", notInstalled: true, timedOut: false };
  if (args[0] === "help") return done(0);
  if (args[0] === "-i") {
    const match = /^add-generic-password -U -s "([^"]+)" -a (\S+) -X ([0-9a-f]+)\n$/u.exec(options.input ?? "");
    if (!match) return done(1);
    items.set(`${match[1]}/${match[2]}`, Buffer.from(match[3]!, "hex").toString("utf8"));
    return done(0);
  }
  const service = args[args.indexOf("-s") + 1];
  const account = args[args.indexOf("-a") + 1];
  const key = `${service}/${account}`;
  if (args[0] === "find-generic-password") {
    return items.has(key) ? done(0, `${items.get(key)}\n`) : done(44);
  }
  if (args[0] === "delete-generic-password") {
    return items.delete(key) ? done(0) : done(44);
  }
  return done(1);
};

/** A Secret Service keyed by attributes, driven the way `secret-tool` is. */
const fakeSecretTool = (items = new Map<string, string>()): SecretToolExec => (command, args, options) => {
  calls.push({ command, args: [...args], ...(options.input ? { input: options.input } : {}) });
  if (command !== "secret-tool") return { status: undefined, stdout: "", notInstalled: true, timedOut: false };
  const attrs = args.filter((arg) => !arg.startsWith("--")).slice(1).join("|");
  if (args[0] === "store") {
    items.set(attrs, options.input ?? "");
    return done(0);
  }
  if (args[0] === "lookup") return items.has(attrs) ? done(0, items.get(attrs)) : done(1);
  if (args[0] === "clear") {
    items.delete(attrs);
    return done(0);
  }
  return done(2);
};

describe("macOS Keychain backend", () => {
  it("saves, reads back, lists and deletes one generic password per secret", () => {
    const items = new Map<string, string>();
    const store = new KeychainCredentialStore({ directory, exec: fakeSecurity(items) });
    expect(store.available).toBe(true);
    store.put(ID, VALUE);
    expect(items.get(`${JUNTO_SECRET_SERVICE}/${ID}`)).toBe(VALUE);
    expect(store.get(ID)).toBe(VALUE);
    expect(store.listIds()).toEqual([ID]);
    store.delete(ID);
    expect(store.get(ID)).toBeUndefined();
    expect(store.listIds()).toEqual([]);
  });

  it("never puts the value on a command line", () => {
    const store = new KeychainCredentialStore({ directory, exec: fakeSecurity() });
    store.put(ID, VALUE);
    for (const call of calls) expect(call.args.join(" ")).not.toContain(VALUE);
    const save = calls.find((call) => call.args[0] === "-i")!;
    expect(save.args).toEqual(["-i"]);
    // On stdin, as hex: nothing to quote, nothing a shell could see.
    expect(save.input).not.toContain(VALUE);
    expect(save.input).toContain(Buffer.from(VALUE, "utf8").toString("hex"));
  });

  it("round-trips values a one-line store cannot hold as they are", () => {
    const store = new KeychainCredentialStore({ directory, exec: fakeSecurity() });
    for (const value of ["line one\nline two\n", "  padded  ", "çédille ✓", "junto-b64:looks-wrapped", 'has "quotes" and $vars']) {
      store.put(ID, value);
      expect(store.get(ID)).toBe(value);
    }
  });

  it("refuses an id that is not a UUID, and reports a refused save", () => {
    const store = new KeychainCredentialStore({ directory, exec: fakeSecurity() });
    expect(() => store.put("../escape", VALUE)).toThrow("credential id is not a UUID");
    expect(store.get("../escape")).toBeUndefined();
    const refusing = new KeychainCredentialStore({
      directory,
      exec: (command, args) => (args[0] === "help" ? done(0) : done(1)),
    });
    expect(() => refusing.put(ID, VALUE)).toThrow("the Keychain refused to save the secret");
  });
});

describe("Linux Secret Service backend", () => {
  it("saves through stdin, reads back by attributes, lists and deletes", () => {
    const items = new Map<string, string>();
    const store = new SecretServiceCredentialStore({ directory, exec: fakeSecretTool(items) });
    expect(store.available).toBe(true);
    store.put(ID, VALUE);
    const save = calls.find((call) => call.args[0] === "store")!;
    expect(save.args).toEqual(["store", `--label=${JUNTO_SECRET_SERVICE}`, "service", JUNTO_SECRET_SERVICE, "id", ID]);
    expect(save.input).toBe(VALUE);
    for (const call of calls) expect(call.args.join(" ")).not.toContain(VALUE);
    expect(store.get(ID)).toBe(VALUE);
    expect(store.listIds()).toEqual([ID]);
    store.put(ID, "two\nlines");
    expect(store.get(ID)).toBe("two\nlines");
    store.delete(ID);
    expect(store.get(ID)).toBeUndefined();
    expect(store.listIds()).toEqual([]);
  });

  it("is unavailable without the tool or without a keyring behind it", () => {
    const noTool = new SecretServiceCredentialStore({
      directory,
      exec: () => ({ status: undefined, stdout: "", notInstalled: true, timedOut: false }),
    });
    expect(noTool.available).toBe(false);
    const noBus = new SecretServiceCredentialStore({ directory, exec: () => done(2) });
    expect(noBus.available).toBe(false);
    const hung = new SecretServiceCredentialStore({
      directory,
      exec: () => ({ status: undefined, stdout: "", notInstalled: false, timedOut: true }),
    });
    expect(hung.available).toBe(false);
    expect(() => noTool.put(ID, VALUE)).toThrow("credential vault is unavailable");
  });
});

describe("picking the backend at startup", () => {
  it("macOS uses the Keychain and says so", () => {
    const opened = openPlatformSecretStore({ directory, platform: "darwin", exec: fakeSecurity() });
    expect(opened.backend).toBe("keychain");
    expect(opened.description).toBe("Junto keeps its secrets in the macOS Keychain.");
  });

  it("Linux uses the keyring when one answers", () => {
    const opened = openPlatformSecretStore({ directory, platform: "linux", exec: fakeSecretTool() });
    expect(opened.backend).toBe("secret-service");
    expect(opened.description).toBe("Junto keeps its secrets in the Linux keyring (Secret Service).");
  });

  it("falls back to owner-only files on a machine with neither, and they work", () => {
    const none: SecretToolExec = () => ({ status: undefined, stdout: "", notInstalled: true, timedOut: false });
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const opened = openPlatformSecretStore({ directory, platform, exec: none });
      expect(opened.backend).toBe("file");
      expect(opened.description).toBe("Junto keeps its secrets in owner-only files in its own folder.");
      opened.store.put(ID, VALUE);
      expect(opened.store.get(ID)).toBe(VALUE);
      expect(opened.store.listIds()).toEqual([ID]);
      opened.store.delete(ID);
    }
  });
});

describe("region secrets, as the screen and the CLI use them", () => {
  const secrets = () =>
    makeRegionSecrets({ store: new MemoryCredentialStore(), backend: "file", description: "test store" });

  it("save mints an id, replace keeps it, remove forgets it, list shows ids only", () => {
    const store = secrets();
    const saved = store.save({ value: VALUE });
    expect(saved.ok).toBe(true);
    const id = (saved as { secretId: string }).secretId;
    expect(id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(JSON.stringify(saved)).not.toContain(VALUE);
    expect(store.read(id)).toBe(VALUE);
    expect(store.save({ value: "second-value", secretId: id.toUpperCase() })).toEqual({ ok: true, secretId: id });
    expect(store.read(id)).toBe("second-value");
    expect(store.list()).toEqual([id]);
    expect(JSON.stringify(store.list())).not.toContain("second-value");
    expect(store.remove(id)).toEqual({ ok: true });
    expect(store.read(id)).toBeUndefined();
    expect(store.remove(id)).toEqual({ ok: true });
    expect(store.remove("not-an-id")).toEqual({ ok: true });
  });

  it("refuses what the shared rules refuse, in plain words, without echoing the value", () => {
    const store = secrets();
    expect(store.save({ value: "" })).toEqual({ ok: false, message: "A secret cannot be empty." });
    expect(store.save({ value: "a\u0000b" })).toMatchObject({ ok: false });
    const big = "x".repeat(SECRET_VALUE_MAX_BYTES + 1);
    expect(store.save({ value: big })).toEqual({ ok: false, message: "A secret can be at most 64 KB." });
    expect(secretValueProblem("x".repeat(SECRET_VALUE_MAX_BYTES))).toBeUndefined();
    expect(store.save({ value: VALUE, secretId: "nope" })).toEqual({ ok: false, message: "That is not a secret id." });
    expect(store.list()).toEqual([]);
  });

  it("a store that fails says the secret was not saved and never shows it", () => {
    const failing = makeRegionSecrets({
      backend: "keychain",
      description: "d",
      store: {
        available: true,
        put: () => {
          throw new Error("the Keychain refused to save the secret");
        },
        get: () => undefined,
        delete: () => undefined,
        listIds: () => [],
      },
    });
    const out = failing.save({ value: VALUE });
    expect(out).toEqual({ ok: false, message: "The secret was not saved: the Keychain refused to save the secret." });
  });
});

describe("redaction", () => {
  it("removes every known value, longest first, and its trimmed form", () => {
    expect(redactSecretValues(`a ${VALUE} b ${VALUE}`, [VALUE])).toBe("a [redacted] b [redacted]");
    expect(redactSecretValues("token-abcdef and abcd", ["abcd", "token-abcdef"])).toBe("[redacted] and [redacted]");
    expect(redactSecretValues("saw secret-1234 here", ["secret-1234\n"])).toBe("saw [redacted] here");
    expect(redactSecretValues("ok", [undefined, "", "ab"])).toBe("ok");
  });
});
