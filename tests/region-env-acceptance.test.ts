/**
 * The acceptance case, end to end on this machine's own code and a FAKE
 * keychain: a region carrying
 *   { kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: ... }
 * puts that variable in the environment of a seat inside it, and of no seat
 * outside it. Then the same token unlocks a 1Password reference in an inner
 * region, passed to the `op` process through its environment.
 *
 * No real Keychain, 1Password or home directory is read.
 */
import { describe, expect, it } from "vitest";
import type { CanvasDoc, EnvSource } from "../src/shared/canvas";
import { makeRegionEnvironmentResolution } from "../src/main/junto/region-env/resolve";
import { makeEnvSourceResolver, OP_TOKEN_NAME } from "../src/main/junto/region-env/sources";
import { removeRegionSecret, saveRegionSecret } from "../src/main/junto/region-env/secret-ipc";
import { makeRegionSecrets } from "../src/main/junto/region-env/secret-store";
import { MemoryCredentialStore } from "../src/main/junto/credentials/store";
import type { ToolCall } from "../src/main/junto/region-env/tool";

const TOKEN = "test-only-region-auth-token";
const REGION_TOKEN_NAME = "EXAMPLE_AUTH_TOKEN";
const SERVICE = "test-region-credential";

const region = (
  id: string,
  rect: readonly [number, number, number, number],
  sources: EnvSource[],
) => ({
  id,
  type: "group" as const,
  x: rect[0],
  y: rect[1],
  width: rect[2],
  height: rect[3],
  label: id,
  ether: { region: { environment: { sources } } },
});
const seat = (id: string, x: number, y: number) => ({
  id,
  type: "text" as const,
  text: id,
  x,
  y,
  width: 50,
  height: 40,
});

const setup = (secrets = makeRegionSecrets({ store: new MemoryCredentialStore(), backend: "file", description: "test" })) => {
  const calls: ToolCall[] = [];
  /** The operator's existing Keychain item, and their 1Password behind the token. */
  const resolver = makeEnvSourceResolver({
    run: async (call) => {
      calls.push(call);
      if (call.command === "/usr/bin/security") {
        return call.args.includes(SERVICE)
          ? { kind: "ok", stdout: `${TOKEN}\n` }
          : { kind: "exit", code: 44, stdout: "", stderr: "" };
      }
      if (call.command === "op") {
        return call.env?.[OP_TOKEN_NAME] === TOKEN
          ? { kind: "ok", stdout: "ghp_from-one-password" }
          : { kind: "timeout" };
      }
      return { kind: "not-installed" };
    },
    platform: "darwin",
    home: "/nonexistent-home",
    secrets,
    toolEnv: async () => ({ PATH: "/usr/bin" }),
  });
  return { calls, secrets, resolution: makeRegionEnvironmentResolution(resolver, "/nonexistent-home") };
};

const doc = (inner: EnvSource[] = [], service = SERVICE): CanvasDoc =>
  ({
    nodes: [
      region("work", [0, 0, 1000, 1000], [
        { id: "op-token", kind: "keychain", name: REGION_TOKEN_NAME, service },
      ]),
      region("privileged", [100, 100, 400, 400], inner),
      seat("inside", 700, 700),
      seat("deep", 200, 200),
      seat("outside", 5000, 5000),
    ],
    edges: [],
  }) as CanvasDoc;

describe("region environment, the acceptance case", () => {
  it("a keychain source on a region yields its variable for a seat inside it", async () => {
    const { resolution, calls } = setup();
    const resolved = await resolution.resolve(doc(), { seat: "inside" }, "local");
    expect(resolved.env).toEqual({ [REGION_TOKEN_NAME]: TOKEN });
    expect(resolved.refusal).toBeUndefined();
    expect(resolved.report).toEqual([
      {
        regionId: "work",
        regionLabel: "work",
        sourceId: "op-token",
        kind: "keychain",
        names: [REGION_TOKEN_NAME],
        status: "ok",
        required: false,
      },
    ]);
    // Read in place: one lookup by service, nothing copied anywhere.
    expect(calls.map((call) => call.command)).toEqual(["/usr/bin/security"]);
  });

  it("a seat outside the region gets nothing, and nothing is read for it", async () => {
    const { resolution, calls } = setup();
    const resolved = await resolution.resolve(doc(), { seat: "outside" }, "local");
    expect(resolved.env).toEqual({});
    expect(resolved.report).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("the value appears in the launch environment and nowhere else", async () => {
    const { resolution } = setup();
    const resolved = await resolution.resolve(doc(), { seat: "inside" }, "local");
    const { env: _env, ...everythingElse } = resolved;
    expect(JSON.stringify(everythingElse)).not.toContain(TOKEN);
  });

  it("an inner region resolves a 1Password reference with that token, passed to op only", async () => {
    const { resolution, calls } = setup();
    const resolved = await resolution.resolve(
      doc([{ id: "gh", kind: "onepassword", name: "GITHUB_TOKEN", ref: "op://Dev/GitHub/token", tokenFrom: "op-token" }]),
      { seat: "deep" },
      "local",
    );
    expect(resolved.env).toEqual({ [REGION_TOKEN_NAME]: TOKEN, GITHUB_TOKEN: "ghp_from-one-password" });
    const op = calls.find((call) => call.command === "op")!;
    expect(op.env?.[OP_TOKEN_NAME]).toBe(TOKEN);
    expect(op.args.join(" ")).not.toContain(TOKEN);
    // The seat outside the inner region gets the token and not the GitHub one.
    const outer = await resolution.resolve(doc([{ id: "gh", kind: "onepassword", name: "GITHUB_TOKEN", ref: "op://Dev/GitHub/token", tokenFrom: "op-token" }]), { seat: "inside" }, "local");
    expect(Object.keys(outer.env)).toEqual([REGION_TOKEN_NAME]);
  });

  it("a missing Keychain item never stops the launch: the seat starts without it and the report says why", async () => {
    const { resolution } = setup();
    const resolved = await resolution.resolve(doc([], "no-such-item"), { seat: "inside" }, "local");
    expect(resolved.env).toEqual({});
    expect(resolved.refusal).toBeUndefined();
    expect(resolved.report[0]).toMatchObject({
      status: "missing",
      names: [REGION_TOKEN_NAME],
      reason: 'No Keychain item with service "no-such-item".',
    });
  });

  it("a secret saved from the screen reaches a seat by id, and is gone after removal", async () => {
    const { resolution, secrets } = setup();
    const saved = saveRegionSecret({ regionId: "privileged", name: "API_KEY", value: "saved-on-the-screen" }, secrets);
    expect(saved.ok).toBe(true);
    const secretId = (saved as { secretId: string }).secretId;
    expect(JSON.stringify(saved)).not.toContain("saved-on-the-screen");
    const withSecret = doc([{ id: "api", kind: "secret", name: "API_KEY", secretId }]);
    expect((await resolution.resolve(withSecret, { seat: "deep" }, "local")).env.API_KEY).toBe("saved-on-the-screen");
    expect(removeRegionSecret(secretId, secrets)).toEqual({ ok: true });
    const after = await resolution.resolve(withSecret, { seat: "deep" }, "local");
    expect(after.env.API_KEY).toBeUndefined();
    expect(after.report.find((entry) => entry.sourceId === "api")).toMatchObject({ status: "missing" });
  });

  it("the save handler refuses malformed input in plain words", () => {
    const { secrets } = setup();
    expect(saveRegionSecret(undefined, secrets)).toEqual({ ok: false, message: "There is no secret to save." });
    expect(saveRegionSecret({ value: 7 }, secrets)).toEqual({ ok: false, message: "There is no secret to save." });
    expect(saveRegionSecret({ value: "v", secretId: 3 }, secrets)).toEqual({ ok: false, message: "That is not a secret id." });
    expect(saveRegionSecret({ value: "" }, secrets)).toEqual({ ok: false, message: "A secret cannot be empty." });
    expect(removeRegionSecret(undefined, secrets)).toEqual({ ok: true });
  });
});
