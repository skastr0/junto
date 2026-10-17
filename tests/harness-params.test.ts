import { Result } from "effect";
import { describe, expect, it } from "vitest";
import {
  checkNativeSetting,
  checkParam,
  paramSpec,
  paramsOfTemplate,
  resolveParams,
  type HarnessParams,
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
    const frozen = checkParam(amp, { key: "mode", value: "ultra", layer: "seat", hasSession: true, current: "low" });
    expect(Result.isFailure(frozen) && frozen.failure.reason).toBe("frozen");
    expect(Result.isSuccess(checkParam(amp, { key: "mode", value: "ultra", layer: "seat", hasSession: false }))).toBe(true);
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
