/**
 * Native config: settings that live in a harness's own config file, as
 * opposed to params, which are flags on one launch. A write here changes how
 * the harness behaves everywhere it runs on that machine, including outside
 * Junto, so it is a separate, explicit operator action.
 *
 * A setting is declared per harness for a range of installed versions, with
 * a closed key and a typed value. A write names the machine, the harness, the
 * key and the value; anything undeclared for that machine's installed version
 * is refused before a file is touched.
 */
import { Result, Schema } from "effect";
import { HarnessId } from "../managed-terminal-templates";
import { isModelId } from "../model-id";
import { HostId } from "../remote-hosts";
import { verifyVersion } from "./inventory";

export const NativeSettingValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("boolean") }),
  Schema.Struct({ kind: Schema.Literal("enum"), values: Schema.Array(Schema.String) }),
  Schema.Struct({
    kind: Schema.Literal("string"),
    maxLength: Schema.Number,
    /** A closed shape the value must also match; `modelId` is `shared/model-id.ts`. */
    format: Schema.optionalKey(Schema.Literal("modelId")),
  }),
  Schema.Struct({ kind: Schema.Literal("number"), minimum: Schema.optionalKey(Schema.Number), maximum: Schema.optionalKey(Schema.Number) }),
]);
export type NativeSettingValue = typeof NativeSettingValue.Type;

export const NativeSettingSpec = Schema.Struct({
  harness: HarnessId,
  /** The harness's own key path, e.g. `permissions.defaultMode`. */
  key: Schema.String,
  label: Schema.String,
  value: NativeSettingValue,
  /** Config file, relative to the operator home (`.claude/settings.json`). */
  file: Schema.String,
  /** Installed versions this declaration was verified against, inclusive. */
  versions: Schema.Struct({ from: Schema.String, through: Schema.optionalKey(Schema.String) }),
  /** The same setting as a launch param, when one exists. */
  param: Schema.optionalKey(Schema.String),
});
export type NativeSettingSpec = typeof NativeSettingSpec.Type;

export const NativeSettingWrite = Schema.Struct({
  machine: HostId,
  harness: HarnessId,
  key: Schema.String,
  value: Schema.Union([Schema.Boolean, Schema.String, Schema.Number]),
});
export type NativeSettingWrite = typeof NativeSettingWrite.Type;

export class NativeSettingRefusedError extends Schema.TaggedError<NativeSettingRefusedError>()(
  "NativeSettingRefusedError",
  {
    harness: Schema.String,
    key: Schema.String,
    reason: Schema.Literals(["undeclared", "version", "value"]),
    message: Schema.String,
  },
) {}

/** Does a value fit its declared spec? A read uses it alone; a write also checks the version. */
export const nativeValueFits = (spec: NativeSettingValue, value: NativeSettingWrite["value"]): boolean => {
  switch (spec.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "string":
      return (
        typeof value === "string" &&
        value.length <= spec.maxLength &&
        (spec.format !== "modelId" || isModelId(value))
      );
    case "number":
      return (
        typeof value === "number" &&
        (spec.minimum === undefined || value >= spec.minimum) &&
        (spec.maximum === undefined || value <= spec.maximum)
      );
  }
};

/** Is a declared setting verified for the machine's installed version? */
export const isNativeSettingVerified = (spec: NativeSettingSpec, installedVersion: string | undefined): boolean =>
  verifyVersion(installedVersion, {
    from: spec.versions.from,
    through: spec.versions.through ?? `${Number.MAX_SAFE_INTEGER}`,
  }).verdict === "verified";

/** Admit a write against the catalogue and the machine's installed version. */
export const checkNativeSetting = (
  catalogue: readonly NativeSettingSpec[],
  write: NativeSettingWrite,
  installedVersion: string | undefined,
): Result.Result<NativeSettingSpec, NativeSettingRefusedError> => {
  const refuse = (reason: NativeSettingRefusedError["reason"], message: string) =>
    Result.fail(new NativeSettingRefusedError({ harness: write.harness, key: write.key, reason, message }));
  const spec = catalogue.find((entry) => entry.harness === write.harness && entry.key === write.key);
  if (!spec) return refuse("undeclared", `${write.harness} has no declared setting ${write.key}`);
  if (!isNativeSettingVerified(spec, installedVersion)) {
    return refuse("version", `${write.key} is not verified for ${write.harness} ${installedVersion ?? "(not installed)"}`);
  }
  if (!nativeValueFits(spec.value, write.value)) return refuse("value", `${String(write.value)} does not fit ${write.key}`);
  return Result.succeed(spec);
};
