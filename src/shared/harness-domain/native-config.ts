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
import { HostId } from "../remote-hosts";

export const NativeSettingValue = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("boolean") }),
  Schema.Struct({ kind: Schema.Literal("enum"), values: Schema.Array(Schema.String) }),
  Schema.Struct({ kind: Schema.Literal("string"), maxLength: Schema.Number }),
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

/** Numeric dotted-version compare; non-numeric parts compare as text. */
const compareVersions = (a: string, b: string): number => {
  const left = a.split(/[.-]/);
  const right = b.split(/[.-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? "0";
    const y = right[i] ?? "0";
    const nx = Number(x);
    const ny = Number(y);
    const order = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y);
    if (order !== 0) return order;
  }
  return 0;
};

const valueFits = (spec: NativeSettingValue, value: NativeSettingWrite["value"]): boolean => {
  switch (spec.kind) {
    case "boolean":
      return typeof value === "boolean";
    case "enum":
      return typeof value === "string" && spec.values.includes(value);
    case "string":
      return typeof value === "string" && value.length <= spec.maxLength;
    case "number":
      return (
        typeof value === "number" &&
        (spec.minimum === undefined || value >= spec.minimum) &&
        (spec.maximum === undefined || value <= spec.maximum)
      );
  }
};

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
  const inRange =
    installedVersion !== undefined &&
    compareVersions(installedVersion, spec.versions.from) >= 0 &&
    (spec.versions.through === undefined || compareVersions(installedVersion, spec.versions.through) <= 0);
  if (!inRange) {
    return refuse("version", `${write.key} is not verified for ${write.harness} ${installedVersion ?? "(not installed)"}`);
  }
  if (!valueFits(spec.value, write.value)) return refuse("value", `${String(write.value)} does not fit ${write.key}`);
  return Result.succeed(spec);
};
