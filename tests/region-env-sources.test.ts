/**
 * Where region environment values come from: one resolver per source kind.
 *
 * Fakes and temp folders only. No test here reads the real Keychain, the
 * real keyring, the real 1Password, or anything under the operator's home:
 * every external tool goes through a scripted `ToolRunner`.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvSource } from "../src/shared/canvas";
import {
  OP_TOKEN_NAME,
  expandHome,
  makeEnvSourceResolver,
  staticNamesOf,
  type SourceContext,
  type SourceDeps,
} from "../src/main/junto/region-env/sources";
import type { ToolCall, ToolResult } from "../src/main/junto/region-env/tool";

const TOKEN = "test-only-service-account-token";

let home: string;
let calls: ToolCall[];

beforeEach(() => {
  vi.stubEnv(OP_TOKEN_NAME, "fake-ambient-service-account-token");
  home = mkdtempSync(join(tmpdir(), "junto-region-env-"));
  calls = [];
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

const resolver = (
  answer: (call: ToolCall) => ToolResult | Promise<ToolResult> = () => ({ kind: "not-installed" }),
  over: Partial<SourceDeps> = {},
) =>
  makeEnvSourceResolver({
    run: async (call) => {
      calls.push(call);
      return answer(call);
    },
    platform: "darwin",
    home,
    secrets: { backend: "file", description: "test store", read: () => undefined },
    toolEnv: async () => ({ PATH: "/usr/bin" }),
    ...over,
  });

const nothing: SourceContext = { resolved: () => undefined };
const src = <S extends EnvSource>(source: S): S => source;

/** No reason, name list or status may ever carry a value. */
const expectNoSecret = (resolution: unknown, value: string): void => {
  const { values: _values, ...rest } = resolution as { values?: unknown };
  expect(JSON.stringify(rest)).not.toContain(value);
};

describe("value", () => {
  it("is the value the operator typed", async () => {
    const out = await resolver().resolve(
      src({ id: "a", kind: "value", name: "NODE_ENV", value: "development" }),
      nothing,
    );
    expect(out).toEqual({ status: "ok", values: { NODE_ENV: "development" } });
    expect(calls).toEqual([]);
  });

  it("refuses a name a process environment would not accept", async () => {
    const out = await resolver().resolve(
      { id: "a", kind: "value", name: "NOT VALID", value: "x" } as EnvSource,
      nothing,
    );
    expect(out).toMatchObject({ status: "error", names: ["NOT VALID"] });
  });
});

describe("secret (Junto's own store)", () => {
  const source = src({ id: "s", kind: "secret", name: "API_KEY", secretId: "0b6f4c1e-2f0a-4c55-9d3e-6a1f1f0c9a11" });

  it("reads the value by id", async () => {
    const out = await resolver(undefined, {
      secrets: { backend: "keychain", description: "d", read: (id) => (id === source.secretId ? "s3cret-value" : undefined) },
    }).resolve(source, nothing);
    expect(out).toEqual({ status: "ok", values: { API_KEY: "s3cret-value" } });
  });

  it("reports a secret that is not saved on this machine as missing", async () => {
    const out = await resolver().resolve(source, nothing);
    expect(out).toEqual({
      status: "missing",
      names: ["API_KEY"],
      reason: "This secret is not saved on this machine.",
    });
  });

  it("says so when the machine has no secret store at all", async () => {
    const out = await resolver(undefined, {
      secrets: { backend: "unavailable", description: "Junto has nowhere to keep secrets on this machine.", read: () => undefined },
    }).resolve(source, nothing);
    expect(out).toMatchObject({ status: "error", reason: "Junto has nowhere to keep secrets on this machine." });
  });
});

describe("keychain (an item that already exists)", () => {
  const source = src({ id: "k", kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "test-region-credential" });

  it("the acceptance case: a keychain source yields its variable, read in place", async () => {
    const out = await resolver((call) =>
      call.command === "/usr/bin/security" ? { kind: "ok", stdout: `${TOKEN}\n` } : { kind: "failed" },
    ).resolve(source, nothing);
    expect(out).toEqual({ status: "ok", values: { EXAMPLE_AUTH_TOKEN: TOKEN } });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: "/usr/bin/security",
      args: ["find-generic-password", "-s", "test-region-credential", "-w"],
    });
    expect(calls[0]!.timeoutMs).toBeGreaterThan(0);
  });

  it("narrows by account when one is given", async () => {
    await resolver(() => ({ kind: "ok", stdout: "v\n" })).resolve({ ...source, account: "ci" }, nothing);
    expect(calls[0]!.args).toEqual(["find-generic-password", "-s", "test-region-credential", "-a", "ci", "-w"]);
  });

  it("an item that is not there is missing, named by service", async () => {
    const out = await resolver(() => ({ kind: "exit", code: 44, stdout: "", stderr: "could not be found" })).resolve(source, nothing);
    expect(out).toEqual({
      status: "missing",
      names: ["EXAMPLE_AUTH_TOKEN"],
      reason: 'No Keychain item with service "test-region-credential".',
    });
  });

  it("a Keychain that does not answer is an error that names the wait, never a hang", async () => {
    const out = await resolver(() => ({ kind: "timeout" })).resolve(source, nothing);
    expect(out).toMatchObject({ status: "error", names: ["EXAMPLE_AUTH_TOKEN"] });
    expect((out as { reason: string }).reason).toContain("waiting for you to unlock");
  });

  it("is an error on a machine that is not a Mac, without running anything", async () => {
    const out = await resolver(undefined, { platform: "linux" }).resolve(source, nothing);
    expect(out).toMatchObject({ status: "error", reason: "Keychain items exist only on macOS." });
    expect(calls).toEqual([]);
  });
});

describe("keyring (an item that already exists)", () => {
  const source = src({ id: "r", kind: "keyring", name: "DB_PASSWORD", attributes: { service: "postgres", user: "app" } });

  it("looks the item up by its attributes", async () => {
    const out = await resolver(() => ({ kind: "ok", stdout: "hunter2-long" }), { platform: "linux" }).resolve(source, nothing);
    expect(out).toEqual({ status: "ok", values: { DB_PASSWORD: "hunter2-long" } });
    expect(calls[0]).toMatchObject({ command: "secret-tool", args: ["lookup", "service", "postgres", "user", "app"] });
  });

  it("no match is missing; no tool is an error", async () => {
    const none = await resolver(() => ({ kind: "exit", code: 1, stdout: "", stderr: "" }), { platform: "linux" }).resolve(source, nothing);
    expect(none).toMatchObject({ status: "missing", names: ["DB_PASSWORD"] });
    const noTool = await resolver(() => ({ kind: "not-installed" }), { platform: "linux" }).resolve(source, nothing);
    expect(noTool).toEqual({
      status: "error",
      names: ["DB_PASSWORD"],
      reason: "secret-tool is not installed on this machine.",
    });
  });

  it("needs at least one attribute", async () => {
    const out = await resolver().resolve({ ...source, attributes: {} }, nothing);
    expect(out).toMatchObject({ status: "error" });
    expect(calls).toEqual([]);
  });
});

describe("onepassword", () => {
  const source = src({ id: "o", kind: "onepassword", name: "GITHUB_TOKEN", ref: "op://Dev/GitHub/token" });

  it("with tokenFrom, the token reaches that one op process through its environment only", async () => {
    const out = await resolver(() => ({ kind: "ok", stdout: "ghp_resolvedvalue" })).resolve(
      { ...source, tokenFrom: "k" },
      { resolved: (id) => (id === "k" ? { [OP_TOKEN_NAME]: TOKEN } : undefined) },
    );
    expect(out).toEqual({ status: "ok", values: { GITHUB_TOKEN: "ghp_resolvedvalue" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("op");
    expect(calls[0]!.args).toEqual(["read", "--no-newline", "op://Dev/GitHub/token"]);
    expect(calls[0]!.args.join(" ")).not.toContain(TOKEN);
    expect(calls[0]!.env).toEqual({ PATH: "/usr/bin", [OP_TOKEN_NAME]: TOKEN });
    // The app's own environment never learns the token.
    expect(process.env[OP_TOKEN_NAME]).toBe("fake-ambient-service-account-token");
  });

  it("an explicit tokenFrom wins over inherited Connect credentials without changing the base", async () => {
    const base = {
      PATH: "/usr/bin", OP_CONNECT_HOST: "https://connect.example.invalid",
      OP_CONNECT_TOKEN: "fake-connect-token", [OP_TOKEN_NAME]: "fake-ambient-token",
    };
    await resolver(() => ({ kind: "ok", stdout: "v" }), {
      toolEnv: async () => base,
    }).resolve({ ...source, tokenFrom: "k" }, { resolved: () => ({ TEST_TOKEN: TOKEN }) });
    expect(calls[0]!.env).toEqual({ PATH: "/usr/bin", [OP_TOKEN_NAME]: TOKEN });
    expect(base.OP_CONNECT_TOKEN).toBe("fake-connect-token");
    expect(base[OP_TOKEN_NAME]).toBe("fake-ambient-token");
  });

  it("takes the single value of the token source whatever its name", async () => {
    await resolver(() => ({ kind: "ok", stdout: "v" })).resolve(
      { ...source, tokenFrom: "k" },
      { resolved: () => ({ MY_OP_TOKEN: TOKEN }) },
    );
    expect(calls[0]!.env?.[OP_TOKEN_NAME]).toBe(TOKEN);
  });

  it("a tokenFrom that is not in scope is missing, and op is never run", async () => {
    const out = await resolver().resolve({ ...source, tokenFrom: "gone" }, nothing);
    expect(out).toEqual({
      status: "missing",
      names: ["GITHUB_TOKEN"],
      reason: "The source this reference takes its 1Password token from is not available here.",
    });
    expect(calls).toEqual([]);
  });

  it("a tokenFrom source that yields several names and none is the token is an error", async () => {
    const out = await resolver().resolve(
      { ...source, tokenFrom: "env" },
      { resolved: () => ({ A: "one-value", B: "two-value" }) },
    );
    expect(out).toMatchObject({ status: "error", names: ["GITHUB_TOKEN"] });
    expect(calls).toEqual([]);
  });

  it("without a token it uses what the machine has, and passes none", async () => {
    await resolver(() => ({ kind: "ok", stdout: "v" })).resolve(source, nothing);
    expect(calls[0]!.env).toEqual({ PATH: "/usr/bin" });
  });

  it("a call left waiting on the desktop app is bounded and says what it needs", async () => {
    const out = await resolver(() => ({ kind: "timeout" })).resolve(source, nothing);
    expect(out).toEqual({
      status: "error",
      names: ["GITHUB_TOKEN"],
      reason: "This needs you to unlock 1Password.",
    });
    expect(calls[0]!.timeoutMs).toBeLessThanOrEqual(10_000);
    const signedOut = await resolver(() => ({
      kind: "exit", code: 1, stdout: "", stderr: "[ERROR] you are not currently signed in",
    })).resolve(source, nothing);
    expect(signedOut).toMatchObject({ reason: "This needs you to unlock 1Password." });
  });

  it("an item that is not there is missing; a refused token and a missing CLI are errors", async () => {
    const gone = await resolver(() => ({
      kind: "exit", code: 1, stdout: "", stderr: `[ERROR] "GitHub" isn't an item in the "Dev" vault`,
    })).resolve(source, nothing);
    expect(gone).toMatchObject({ status: "missing" });
    const refused = await resolver(() => ({
      kind: "exit", code: 1, stdout: "", stderr: `[ERROR] invalid token ${TOKEN}`,
    })).resolve({ ...source, tokenFrom: "k" }, { resolved: () => ({ T: TOKEN }) });
    expect(refused).toMatchObject({ status: "error", reason: "1Password refused the service account token." });
    expectNoSecret(refused, TOKEN);
    const noCli = await resolver(() => ({ kind: "not-installed" })).resolve(source, nothing);
    expect(noCli).toMatchObject({ reason: "The 1Password CLI (op) is not installed on this machine." });
  });

  it("refuses a reference that is not op://", async () => {
    const out = await resolver().resolve({ ...source, ref: "Dev/GitHub/token" }, nothing);
    expect(out).toMatchObject({ status: "error" });
    expect(calls).toEqual([]);
  });
});

describe("envFile", () => {
  it("reads every name: quotes, comments, export, multi-line", async () => {
    writeFileSync(
      join(home, ".env"),
      [
        "# database",
        "DB_HOST=localhost",
        "export DB_PORT=5432",
        'DB_URL="postgres://u:p@h/db?x=1#frag"',
        "GREETING='hello $USER # not a comment'",
        "TRAILING=value   # a comment",
        'MULTI="line one\\nline two"',
        'KEY="-----BEGIN\nBODY\n-----END"',
        "EMPTY=",
        "not an assignment",
        "9BAD=x",
        "DB_HOST=override",
      ].join("\n"),
    );
    const out = await resolver().resolve(src({ id: "e", kind: "envFile", path: "~/.env" }), nothing);
    expect(out).toEqual({
      status: "ok",
      values: {
        DB_HOST: "override",
        DB_PORT: "5432",
        DB_URL: "postgres://u:p@h/db?x=1#frag",
        GREETING: "hello $USER # not a comment",
        TRAILING: "value",
        MULTI: "line one\nline two",
        KEY: "-----BEGIN\nBODY\n-----END",
        EMPTY: "",
      },
    });
  });

  it("a missing file is missing, with no names; a relative path is an error", async () => {
    const gone = await resolver().resolve(src({ id: "e", kind: "envFile", path: "~/nope/.env" }), nothing);
    expect(gone).toEqual({ status: "missing", names: [], reason: "~/nope/.env does not exist." });
    const relative = await resolver().resolve(src({ id: "e", kind: "envFile", path: "config/.env" }), nothing);
    expect(relative).toMatchObject({ status: "error", names: [] });
    mkdirSync(join(home, "dir"));
    const directory = await resolver().resolve(src({ id: "e", kind: "envFile", path: "~/dir" }), nothing);
    expect(directory).toMatchObject({ status: "error", reason: "~/dir is not a file." });
  });
});

describe("secretsDir", () => {
  beforeEach(() => {
    const dir = join(home, "secrets");
    mkdirSync(dir);
    writeFileSync(join(dir, "API_KEY"), "key-from-file\n");
    writeFileSync(join(dir, "db_password"), "pw");
    writeFileSync(join(dir, ".hidden"), "x");
    writeFileSync(join(dir, "not-a-name"), "x");
    mkdirSync(join(dir, "SUBDIR"));
    writeFileSync(join(home, "target"), "linked\n");
    symlinkSync(join(home, "target"), join(dir, "LINKED"));
  });

  it("one file per variable, named as written, one trailing newline dropped", async () => {
    const out = await resolver().resolve(src({ id: "d", kind: "secretsDir", path: "~/secrets" }), nothing);
    expect(out).toEqual({
      status: "ok",
      values: { API_KEY: "key-from-file", LINKED: "linked", db_password: "pw" },
    });
  });

  it("applies the prefix to every name", async () => {
    const out = await resolver().resolve(
      src({ id: "d", kind: "secretsDir", path: join(home, "secrets"), prefix: "APP_" }),
      nothing,
    );
    expect(Object.keys((out as { values: object }).values).sort()).toEqual([
      "APP_API_KEY",
      "APP_LINKED",
      "APP_db_password",
    ]);
  });

  it("a missing folder is missing", async () => {
    const out = await resolver().resolve(src({ id: "d", kind: "secretsDir", path: "~/absent" }), nothing);
    expect(out).toEqual({ status: "missing", names: [], reason: "~/absent does not exist." });
  });
});

describe("command", () => {
  const source = src({ id: "c", kind: "command", name: "AWS_TOKEN", argv: ["aws-vault", "print", "dev"] });

  it("stdout is the value; argv goes to the program unshelled", async () => {
    const out = await resolver(() => ({ kind: "ok", stdout: "tok-12345\n" })).resolve(source, nothing);
    expect(out).toEqual({ status: "ok", values: { AWS_TOKEN: "tok-12345" } });
    expect(calls[0]).toMatchObject({ command: "aws-vault", args: ["print", "dev"] });
  });

  it("a failing command is an error whose words never carry what it printed as the value", async () => {
    const out = await resolver(() => ({
      kind: "exit", code: 3, stdout: "half-a-secret-9876\n", stderr: "denied for half-a-secret-9876\nmore",
    })).resolve(source, nothing);
    expect(out).toEqual({
      status: "error",
      names: ["AWS_TOKEN"],
      reason: 'The command "aws-vault" exited with code 3.',
    });
  });

  it.each(["stderr-only-canary", "x", "encoded-canary%2Fvalue"])(
    "does not forward untrusted stderr when stdout is empty (%s)",
    async (canary) => {
      const out = await resolver(() => ({
        kind: "exit", code: 3, stdout: "", stderr: `failed using ${canary}`,
      })).resolve(source, nothing);
      expect(out).toEqual({
        status: "error", names: ["AWS_TOKEN"],
        reason: 'The command "aws-vault" exited with code 3.',
      });
    },
  );

  it("a command that does not finish is bounded", async () => {
    const out = await resolver(() => ({ kind: "timeout" })).resolve(source, nothing);
    expect(out).toMatchObject({ status: "error", reason: 'The command "aws-vault" did not finish in time.' });
  });
});

describe("the law for every kind", () => {
  const all: EnvSource[] = [
    { id: "1", kind: "value", name: "A", value: "v" },
    { id: "2", kind: "secret", name: "B", secretId: "0b6f4c1e-2f0a-4c55-9d3e-6a1f1f0c9a11" },
    { id: "3", kind: "keychain", name: "C", service: "svc" },
    { id: "4", kind: "keyring", name: "D", attributes: { a: "b" } },
    { id: "5", kind: "onepassword", name: "E", ref: "op://v/i/f" },
    { id: "6", kind: "envFile", path: "~/.env" },
    { id: "7", kind: "secretsDir", path: "~/secrets" },
    { id: "8", kind: "command", name: "F", argv: ["x"] },
  ];

  it("never throws into a launch, whatever the tools and stores do", async () => {
    const hostile = resolver(
      () => {
        throw new Error(`boom ${TOKEN}`);
      },
      {
        secrets: {
          backend: "file",
          description: "d",
          read: () => {
            throw new Error(`store exploded ${TOKEN}`);
          },
        },
        toolEnv: async () => {
          throw new Error("no env");
        },
      },
    );
    for (const source of all) {
      const out = await hostile.resolve(source, {
        resolved: () => {
          throw new Error("context exploded");
        },
      });
      expect(["ok", "missing", "error"]).toContain(out.status);
      expectNoSecret(out, TOKEN);
    }
  });

  it("knows the names of single-name sources without resolving them", () => {
    expect(all.map(staticNamesOf)).toEqual([["A"], ["B"], ["C"], ["D"], ["E"], [], [], ["F"]]);
  });

  it("expands ~/ and refuses relative paths", () => {
    expect(expandHome("~/x/y", "/home/op")).toBe("/home/op/x/y");
    expect(expandHome("~", "/home/op")).toBe("/home/op");
    expect(expandHome("/etc/x", "/home/op")).toBe("/etc/x");
    expect(expandHome("x/y", "/home/op")).toBeUndefined();
    expect(expandHome("~other/x", "/home/op")).toBeUndefined();
  });
});
