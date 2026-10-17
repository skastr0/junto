import { describe, expect, it } from "vitest";
import { paramSpec } from "../src/shared/harness-domain";
import { recoverDocumentLaunchChoices } from "../src/shared/launch-choices";
import { type ManagedLaunchChoices, resolveManagedLaunch } from "../src/shared/managed-terminal-launch";
import { HARNESS_RECORDS } from "../src/shared/harness-records";
import { HARNESS_IDS, type HarnessId } from "../src/shared/managed-terminal-templates";

/** One choice per dial the harness declares, and every permission mode it lists. */
const choicesFor = (harness: HarnessId): ManagedLaunchChoices[] => {
  const params = HARNESS_RECORDS[harness].params;
  const first = (key: "effort" | "mode"): string | undefined => {
    const spec = paramSpec(params, key);
    if (!spec) return undefined;
    return spec.options.source === "fixed" ? (spec.options.values[0] ?? `${key}-1`) : `${key}-1`;
  };
  const base: ManagedLaunchChoices = {
    ...(paramSpec(params, "model") ? { model: "model-1" } : {}),
    ...(paramSpec(params, "provider") ? { provider: "provider-1" } : {}),
    ...(first("effort") ? { effort: first("effort") } : {}),
    ...(first("mode") ? { mode: first("mode") } : {}),
    ...(paramSpec(params, "profile") ? { profile: "profile-1" } : {}),
  };
  const permission = paramSpec(params, "permissionMode");
  if (!permission) return [base];
  const modes =
    permission.emit.via === "switch"
      ? [permission.emit.value]
      : permission.options.source === "fixed"
        ? permission.options.values
        : [permission.defaultValue ?? "mode-1"];
  return modes.map((permissionMode) => ({ ...base, permissionMode }));
};

describe("launch round trip", () => {
  it("recovers every harness's launch into choices that resolve to the same launch", () => {
    for (const harness of HARNESS_IDS) {
      for (const choices of choicesFor(harness)) {
        const label = `${harness} ${JSON.stringify(choices)}`;
        const launch = resolveManagedLaunch(harness, choices, {});
        const recovered = recoverDocumentLaunchChoices(harness, launch);
        const again = resolveManagedLaunch(harness, recovered, {});
        expect(again.argv, label).toEqual(launch.argv);
        expect(again.env, label).toEqual(launch.env);
      }
    }
  });

  it("recovers each choice as it was made, except an effort carried in a model slug", () => {
    for (const harness of HARNESS_IDS) {
      const params = HARNESS_RECORDS[harness].params;
      const slugged = paramSpec(params, "effort")?.emit.via === "modelSlug";
      for (const choices of choicesFor(harness)) {
        const recovered = recoverDocumentLaunchChoices(harness, resolveManagedLaunch(harness, choices, {}));
        const permission = paramSpec(params, "permissionMode");
        const silent =
          permission?.emit.via === "perValue" && (permission.emit.argv[choices.permissionMode ?? ""] ?? []).length === 0;
        const expected = { ...choices };
        if (slugged) {
          delete (expected as { effort?: string }).effort;
          if (choices.model && choices.effort) (expected as { model?: string }).model = recovered.model;
        }
        if (silent) delete (expected as { permissionMode?: string }).permissionMode;
        expect(recovered, `${harness} ${JSON.stringify(choices)}`).toEqual(expected);
      }
    }
  });

  it("reads Amp's long mode spelling", () => {
    expect(
      recoverDocumentLaunchChoices("amp", { kind: "harness", argv: ["amp", "--no-ide", "--mode", "low"] }),
    ).toEqual({ mode: "low" });
  });
});
