import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { readJsonKey, readTomlKey, writeJsonKey, writeTomlKey } from "../src/main/junto/native-config/edit";
import { makeNativeConfig } from "../src/main/junto/native-config/service";
import { HarnessInventory } from "../src/main/junto/term/templates/harness-inventory";
import type { MachineInventory } from "../src/shared/harness-domain/inventory";

describe("JSON keys", () => {
  it("changes one nested key and keeps comments and other keys", () => {
    const text = `{\n  // mine\n  "permissions": {\n    "allow": ["Read"],\n    "defaultMode": "default"\n  },\n  "model": "opus"\n}\n`;
    const edited = writeJsonKey(text, "permissions.defaultMode", "auto");
    expect(edited.ok && edited.text).toBe(text.replace('"default"', '"auto"'));
    expect(readJsonKey(edited.ok ? edited.text : "", "permissions.defaultMode")).toEqual({ ok: true, value: "auto" });
  });

  it("adds a missing key and creates an empty file's object", () => {
    const edited = writeJsonKey("", "alwaysThinkingEnabled", true);
    expect(edited.ok && JSON.parse(edited.text)).toEqual({ alwaysThinkingEnabled: true });
  });

  it("refuses a file that is not JSON", () => {
    expect(writeJsonKey("{ nope", "model", "x").ok).toBe(false);
  });

  it("reads an object where a setting should be as unsupported", () => {
    expect(readJsonKey(`{"model": {"a": 1}}`, "model").ok).toBe(false);
  });
});

describe("TOML top-level keys", () => {
  const text = `# codex\nmodel = "gpt-5" # pinned\napproval_policy = 'on-request'\n\n[profiles.fast]\nmodel = "mini"\n`;

  it("changes the top-level key, keeps its comment and leaves tables alone", () => {
    const edited = writeTomlKey(text, "model", "gpt-5.5");
    expect(edited.ok && edited.text).toBe(text.replace('"gpt-5" # pinned', '"gpt-5.5" # pinned'));
    expect(readTomlKey(text, "approval_policy")).toEqual({ ok: true, value: "on-request" });
  });

  it("adds a missing key before the first table", () => {
    const edited = writeTomlKey(text, "sandbox_mode", "workspace-write");
    expect(edited.ok && edited.text).toBe(
      `# codex\nmodel = "gpt-5" # pinned\napproval_policy = 'on-request'\nsandbox_mode = "workspace-write"\n\n[profiles.fast]\nmodel = "mini"\n`,
    );
  });

  it("never reads a table's key as the top-level one", () => {
    expect(readTomlKey(`[profiles.fast]\nmodel = "mini"\n`, "model")).toEqual({ ok: true, value: undefined });
  });

  it("keeps a newline-and-bracket value inside its own string", () => {
    const hostile = `x"\n[mcp_servers.a]\ncommand = "evil"`;
    const toml = writeTomlKey(text, "model", hostile);
    expect(toml.ok && toml.text.split("\n").filter((line) => line.startsWith("[")).length).toBe(1);
    expect(readTomlKey(toml.ok ? toml.text : "", "model")).toEqual({ ok: true, value: hostile });
    const json = writeJsonKey(`{}\n`, "model", hostile);
    expect(json.ok && JSON.parse(json.text)).toEqual({ model: hostile });
  });

  it("escapes DEL and refuses a lone surrogate, which TOML forbids raw", () => {
    const del = writeTomlKey(text, "model", "a\u007Fb");
    expect(del.ok && del.text).toContain('model = "a\\u007Fb"');
    expect(readTomlKey(del.ok ? del.text : "", "model")).toEqual({ ok: true, value: "a\u007Fb" });
    expect(writeTomlKey(text, "model", "a\uD800b").ok).toBe(false);
  });

  it("refuses a dotted key", () => {
    expect(writeTomlKey(text, "profiles.fast.model", "x").ok).toBe(false);
  });
});

describe("NativeConfig", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  const snapshot = (version: string | undefined): MachineInventory => ({
    machine: "mac",
    harnesses: [{
      harness: "claude", machine: "mac", installed: true, models: [], efforts: [], refreshing: false,
      ...(version === undefined ? {} : { version }),
    }],
  });

  const run = <A, E>(version: string | undefined, use: (config: Effect.Success<ReturnType<typeof makeNativeConfig>>) => Effect.Effect<A, E>) => {
    const inventory = Layer.succeed(HarnessInventory, HarnessInventory.of({
      harnesses: () => Effect.succeed([]),
      models: () => Effect.die("unused"),
      machine: Effect.succeed(snapshot(version)),
    }));
    return Effect.runPromiseExit(
      Effect.flatMap(makeNativeConfig({ home: home! }), use).pipe(Effect.provide(inventory)),
    );
  };

  const settingsPath = () => join(home!, ".claude", "settings.json");

  it("writes after a read, backs up with the mode kept, and answers the value read back", async () => {
    home = mkdtempSync(join(tmpdir(), "junto-native-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(settingsPath(), `{\n  "permissions": { "defaultMode": "default" }\n}\n`, { mode: 0o640 });
    const exit = await run("2.1.302", (config) => Effect.gen(function* () {
      expect(yield* config.read("claude", ["permissions.defaultMode"])).toEqual({ "permissions.defaultMode": "default" });
      return yield* config.write({ machine: "mac", harness: "claude", key: "permissions.defaultMode", value: "auto" });
    }));
    expect(exit).toEqual(Exit.succeed("auto"));
    expect(JSON.parse(readFileSync(settingsPath(), "utf8")).permissions.defaultMode).toBe("auto");
    expect(statSync(settingsPath()).mode & 0o777).toBe(0o640);
    expect(statSync(`${settingsPath()}.junto-backup`).mode & 0o777).toBe(0o640);
  });

  it("answers a conflict when the file changed since this machine read it", async () => {
    home = mkdtempSync(join(tmpdir(), "junto-native-"));
    mkdirSync(join(home, ".claude"));
    writeFileSync(settingsPath(), `{}\n`);
    const exit = await run("2.1.302", (config) => Effect.gen(function* () {
      yield* config.read("claude", ["model"]);
      writeFileSync(settingsPath(), `{"model": "sonnet"}\n`);
      return yield* config.write({ machine: "mac", harness: "claude", key: "model", value: "opus" });
    }));
    expect(Exit.isFailure(exit) && JSON.stringify(exit.cause)).toContain("conflict");
    expect(readFileSync(settingsPath(), "utf8")).toBe(`{"model": "sonnet"}\n`);
  });

  it("refuses an undeclared key or a version outside the declaration before touching a file", async () => {
    home = mkdtempSync(join(tmpdir(), "junto-native-"));
    const undeclared = await run("2.1.302", (config) =>
      config.write({ machine: "mac", harness: "claude", key: "hooks", value: "x" }));
    expect(Exit.isFailure(undeclared) && JSON.stringify(undeclared.cause)).toContain("undeclared");
    const old = await run("1.0.0", (config) =>
      config.write({ machine: "mac", harness: "claude", key: "model", value: "opus" }));
    expect(Exit.isFailure(old) && JSON.stringify(old.cause)).toContain("version");
    expect(existsSync(settingsPath())).toBe(false);
  });
});
