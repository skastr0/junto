import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  checkNativeSetting,
  checkParam,
  paramSpec,
  paramsOfTemplate,
  resolveParams,
  type HarnessParams,
  verifyVersion,
} from "../src/shared/harness-domain";
import { HARNESS_RECORDS } from "../src/shared/harness-records";
import { resolveManagedLaunch } from "../src/shared/managed-terminal-launch";
import { HARNESS_IDS, templateFor } from "../src/shared/managed-terminal-templates";

const params = (harness: (typeof HARNESS_IDS)[number]): HarnessParams => paramsOfTemplate(templateFor(harness));

describe("harness params", () => {
  it("declares every dial a template emits, for every harness", () => {
    for (const harness of HARNESS_IDS) {
      const spec = templateFor(harness).argvSpec;
      const declared = params(harness);
      expect(declared.harness).toBe(harness);
      expect(Boolean(paramSpec(declared, "model"))).toBe(Boolean(spec.modelFlag ?? spec.modelEnvKey));
      expect(Boolean(paramSpec(declared, "mode"))).toBe(Boolean(spec.modeFlag));
      expect(Boolean(paramSpec(declared, "profile"))).toBe(Boolean(spec.profileFlag));
      expect(Boolean(paramSpec(declared, "provider"))).toBe(Boolean(spec.providerFlag));
      expect(paramSpec(declared, "extraArgs")).toBeDefined();
    }
  });

  it("emits codex effort as a config key and cursor effort on the model", () => {
    expect(paramSpec(params("codex"), "effort")?.emit).toEqual({ via: "configKey", key: "model_reasoning_effort" });
    expect(paramSpec(params("cursor"), "effort")?.emit.via ?? "absent").toMatch(/modelSlug|absent/);
  });

  it("declares a bare permission flag as a switch for yolo", () => {
    for (const harness of HARNESS_IDS) {
      const { permissionModeFlag: flag, permissionArgv } = templateFor(harness).argvSpec;
      if (permissionArgv || (flag !== "--yolo" && flag !== "--dangerously-skip-permissions")) continue;
      expect(paramSpec(params(harness), "permissionMode")?.emit).toEqual({ via: "switch", flag, value: "yolo" });
    }
  });

  it("refuses a profile name that could not cross the link", () => {
    const hermes = HARNESS_RECORDS.hermes.params;
    expect(paramSpec(hermes, "profile")?.format).toBe("profileName");
    const check = (value: string) => checkParam(hermes, { key: "profile", value, layer: "launch" });
    for (const name of ["work", "Coder_2", "a-b"]) expect(Result.isSuccess(check(name)), name).toBe(true);
    for (const name of ["-x", "../etc", "a:b", "a.b", "a/b"]) {
      const refused = check(name);
      expect(Result.isFailure(refused) && refused.failure.reason, name).toBe("shape");
    }
  });

  it("closes a mode list unless the record opens it", () => {
    for (const harness of HARNESS_IDS) {
      const mode = paramSpec(HARNESS_RECORDS[harness].params, "mode");
      if (!mode) continue;
      expect(mode.custom, harness).toBe(harness === "amp");
    }
    const cursor = HARNESS_RECORDS.cursor.params;
    if (paramSpec(cursor, "mode")) {
      const refused = checkParam(cursor, { key: "mode", value: "made-up", layer: "seat" });
      expect(Result.isFailure(refused) && refused.failure.reason).toBe("offList");
    }
  });

  it("freezes Amp's mode once the thread exists", () => {
    const amp = params("amp");
    expect(paramSpec(amp, "mode")?.resume).toBe("frozenWithSession");
    const frozen = checkParam(amp, { key: "mode", value: "ultra", layer: "seat", settingsFixed: true, current: "low" });
    expect(Result.isFailure(frozen) && frozen.failure.reason).toBe("frozen");
    expect(Result.isSuccess(checkParam(amp, { key: "mode", value: "ultra", layer: "seat", settingsFixed: false }))).toBe(true);
  });

  it("refuses an effort off a fixed list and a param the harness lacks", () => {
    const claude = params("claude");
    const off = checkParam(claude, { key: "effort", value: "ludicrous", layer: "launch" });
    expect(Result.isFailure(off) && off.failure.reason).toBe("offList");
    const missing = checkParam(claude, { key: "profile", value: "work", layer: "launch" });
    expect(Result.isFailure(missing) && missing.failure.reason).toBe("unknown");
  });

  it("declares Devin's autonomous mode as unoffered with its sandbox companion", () => {
    const permission = paramSpec(params("devin"), "permissionMode");
    expect(permission?.companions).toEqual({ autonomous: ["--sandbox"] });
    expect(permission?.unoffered).toEqual(["autonomous"]);
    const argv = resolveManagedLaunch("devin", { permissionMode: "autonomous" }, {}).argv ?? [];
    expect(argv).toContain("--sandbox");
    expect(argv.indexOf("--sandbox")).toBeLessThan(argv.indexOf("--permission-mode"));
  });

  it("resolves launch over seat over harness default, extra args whole", () => {
    const resolved = resolveParams(params("claude"), {
      harnessDefault: { model: "opus", effort: "high", extraArgs: ["--verbose"] },
      seat: { effort: "max" },
      launch: { model: "  ", extraArgs: [] },
    });
    expect(resolved.values).toEqual({ model: "opus", effort: "max", extraArgs: [] });
    expect(resolved.from).toEqual({ model: "harnessDefault", effort: "seat", extraArgs: "launch" });
  });

  it("puts the machine override between the app default and the seat", () => {
    const resolved = resolveParams(params("claude"), {
      harnessDefault: { model: "opus", effort: "high" },
      machineDefault: { model: "sonnet" },
      seat: { effort: "max" },
    });
    expect(resolved.values).toEqual({ model: "sonnet", effort: "max" });
    expect(resolved.from).toEqual({ model: "machineDefault", effort: "seat" });
    expect(resolveParams(params("claude"), {}).values).toEqual({});
  });

  it("admits a native setting only when declared for the installed version", () => {
    const catalogue = [
      {
        harness: "claude",
        key: "permissions.defaultMode",
        label: "Default mode",
        value: { kind: "enum", values: ["default", "acceptEdits", "plan"] },
        file: ".claude/settings.json",
        versions: { from: "2.1.200" },
      },
    ] as const;
    const write = { machine: "local", harness: "claude", key: "permissions.defaultMode", value: "plan" } as const;
    expect(Result.isSuccess(checkNativeSetting(catalogue, write as never, "2.1.302"))).toBe(true);
    const old = checkNativeSetting(catalogue, write as never, "2.0.9");
    expect(Result.isFailure(old) && old.failure.reason).toBe("version");
    const bad = checkNativeSetting(catalogue, { ...write, value: "yolo" } as never, "2.1.302");
    expect(Result.isFailure(bad) && bad.failure.reason).toBe("value");
  });

  it("admits a model value only in the model id shape", () => {
    const catalogue = [
      {
        harness: "claude",
        key: "model",
        label: "Model",
        value: { kind: "string", maxLength: 200, format: "modelId" },
        file: ".claude/settings.json",
        versions: { from: "2.1.200" },
      },
    ] as const;
    const write = (value: string) => checkNativeSetting(catalogue, { machine: "local", harness: "claude", key: "model", value } as never, "2.1.302");
    for (const id of ["opus[1m]", "claude-fable-5-1[1m]", "openrouter/~anthropic/claude-opus-latest", "gpt-5.1-codex@high"]) {
      expect(Result.isSuccess(write(id)), id).toBe(true);
    }
    for (const id of ['opus"', "a b", "<x>", "x\u202e", "$(id)"]) {
      expect(Result.isFailure(write(id)), id).toBe(true);
    }
  });

  it("reads an installed version against the record's verified range", () => {
    const range = { from: "0.20.4", through: "0.21.6" };
    expect(verifyVersion("hermes v0.21.6+675", range).verdict).toBe("verified");
    expect(verifyVersion("0.21.10", range).verdict).toBe("newer");
    expect(verifyVersion("0.9.4", range).verdict).toBe("older");
    expect(verifyVersion("2026.10.14", { from: "2026.9.1", through: "2026.10.14" }).verdict).toBe("verified");
    expect(verifyVersion("amp 0.0.1760000000", { from: "0.0.1750000000", through: "0.0.1759999999" }).verdict).toBe("newer");
    expect(verifyVersion("dev build", range).verdict).toBe("unknown");
    expect(verifyVersion(undefined, range)).toEqual({ verdict: "unknown", ...range });
  });

  it("keeps a provider on the layer its model came from", () => {
    const hermes = params("hermes");
    if (!paramSpec(hermes, "provider")) return;
    const resolved = resolveParams(
      { ...hermes, params: hermes.params.map((spec) => ({ ...spec, layers: ["harnessDefault", "seat", "launch"] as const })) },
      { harnessDefault: { provider: "openrouter" }, launch: { model: "gpt" } },
    );
    expect(resolved.values.model).toBe("gpt");
    expect(resolved.values.provider).toBeUndefined();
  });
});
