/**
 * The closed list of settings Junto may read and write in a harness's own
 * config file (docs/machines.md, Harness inventory: native config). Each key
 * was checked against the installed binary named in its `versions.from`.
 *
 * No key here names a program, a script, a path, a directory or a URL, or is
 * executed or loaded as code, and none sits inside an `env` block. Adding a
 * key is a `remote-security` review.
 */
import { Result } from "effect";
import type { HarnessId } from "../managed-terminal-templates";
import { checkNativeSetting, type NativeSettingSpec, type NativeSettingWrite } from "./native-config";

const CLAUDE_FILE = ".claude/settings.json";
const CODEX_FILE = ".codex/config.toml";

export const NATIVE_SETTINGS: readonly NativeSettingSpec[] = [
  {
    harness: "claude",
    key: "model",
    label: "Model",
    // Schema: "Override the default model used by Claude Code"; aliases or a full id.
    value: { kind: "string", maxLength: 200 },
    file: CLAUDE_FILE,
    versions: { from: "2.1.302" },
    param: "model",
  },
  {
    harness: "claude",
    key: "effortLevel",
    label: "Effort",
    // Schema on 2.1.302: effortLevel: enum(["low","medium","high","xhigh"]).
    value: { kind: "enum", values: ["low", "medium", "high", "xhigh"] },
    file: CLAUDE_FILE,
    versions: { from: "2.1.302" },
    param: "effort",
  },
  {
    harness: "claude",
    key: "permissions.defaultMode",
    label: "Permission mode",
    // 2.1.302 lists acceptEdits, auto, bypassPermissions, default, dontAsk, plan.
    value: { kind: "enum", values: ["default", "acceptEdits", "auto", "plan", "dontAsk", "bypassPermissions"] },
    file: CLAUDE_FILE,
    versions: { from: "2.1.302" },
    param: "permissionMode",
  },
  {
    harness: "claude",
    key: "alwaysThinkingEnabled",
    label: "Always think",
    value: { kind: "boolean" },
    file: CLAUDE_FILE,
    versions: { from: "2.1.302" },
  },
  {
    harness: "codex",
    key: "model",
    label: "Model",
    value: { kind: "string", maxLength: 200 },
    file: CODEX_FILE,
    versions: { from: "0.162.1" },
    param: "model",
  },
  {
    harness: "codex",
    key: "model_reasoning_effort",
    label: "Effort",
    // `codex debug models` on 0.162.1, union of every model's reasoning levels.
    value: { kind: "enum", values: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    file: CODEX_FILE,
    versions: { from: "0.162.1" },
    param: "effort",
  },
  {
    harness: "codex",
    key: "approval_policy",
    label: "Approval policy",
    // `-a` on 0.162.1 parses only on-request and never.
    value: { kind: "enum", values: ["on-request", "never"] },
    file: CODEX_FILE,
    versions: { from: "0.162.1" },
    param: "permissionMode",
  },
  {
    harness: "codex",
    key: "sandbox_mode",
    label: "Sandbox",
    // `--sandbox` on 0.162.1: read-only, workspace-write, danger-full-access.
    value: { kind: "enum", values: ["read-only", "workspace-write", "danger-full-access"] },
    file: CODEX_FILE,
    versions: { from: "0.162.1" },
  },
];

/** A value every declaration admits, so the version check can be asked on its own. */
const admittedValue = (spec: NativeSettingSpec): NativeSettingWrite["value"] => {
  switch (spec.value.kind) {
    case "boolean":
      return false;
    case "enum":
      return spec.value.values[0] ?? "";
    case "string":
      return "";
    case "number":
      return spec.value.minimum ?? spec.value.maximum ?? 0;
  }
};

/** The settings a machine offers for a harness at its installed version. */
export const nativeSettingsFor = (
  harness: HarnessId,
  machine: string,
  installedVersion: string | undefined,
  catalogue: readonly NativeSettingSpec[] = NATIVE_SETTINGS,
): readonly NativeSettingSpec[] =>
  catalogue.filter(
    (spec) =>
      spec.harness === harness &&
      Result.isSuccess(
        checkNativeSetting(catalogue, { machine, harness, key: spec.key, value: admittedValue(spec) }, installedVersion),
      ),
  );
