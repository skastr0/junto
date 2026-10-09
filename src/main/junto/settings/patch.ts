import { Result, SchemaIssue, Schema } from "effect";
import {
  Settings,
  SettingsError,
  SettingsPatch,
  MachinePreferencesPatch,
  applySettingsPatch,
  offboardRules,
  type Settings as SettingsValue,
  type SettingsPatch as SettingsPatchValue,
  type MachinePreferencesPatch as MachinePreferencesPatchValue,
} from "@shared/settings";
import { offboardRulesProblem } from "@shared/seat-offboard";

const STRICT_DECODE_OPTIONS = {
  onExcessProperty: "error",
} as const;

const decodeSettings = Schema.decodeUnknownResult(
  Settings,
  STRICT_DECODE_OPTIONS,
);
const decodeSettingsPatch = Schema.decodeUnknownResult(
  SettingsPatch,
  STRICT_DECODE_OPTIONS,
);
const decodePreferencesPatch = Schema.decodeUnknownResult(
  MachinePreferencesPatch,
  STRICT_DECODE_OPTIONS,
);

const formatParse = (error: Schema.SchemaError): string =>
  error instanceof Error ? error.message : String(error);

export const decodePatchInput = (
  raw: unknown,
): Result.Result<SettingsPatchValue, SettingsError> =>
  decodeSettingsPatch(raw).pipe(
    Result.mapError(
      (error) =>
        new SettingsError({
          message: `settings patch invalid: ${formatParse(error)}`,
          code: "validation",
        }),
    ),
  );

export const applyAndValidatePatch = (
  current: SettingsValue,
  patch: SettingsPatchValue,
): Result.Result<SettingsValue, SettingsError> => {
  const merged = applySettingsPatch(current, patch);
  // The offboard rules hang together (the nudge inside the cache window, the
  // auto offboard at or after it), which a field-by-field schema cannot say.
  if (patch.offboard !== undefined) {
    const problem = offboardRulesProblem(offboardRules(merged));
    if (problem !== undefined) {
      return Result.fail(new SettingsError({ message: problem, code: "validation" }));
    }
  }
  return decodeSettings(merged).pipe(
    Result.mapError(
      (error) =>
        new SettingsError({
          message: `settings after patch invalid: ${formatParse(error)}`,
          code: "validation",
        }),
    ),
  );
};

/** Decode the dedicated supervision preference. */
export const decodeMachinePreferencesPatch = (
  raw: unknown,
): Result.Result<MachinePreferencesPatchValue, SettingsError> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Result.fail(
      new SettingsError({
        message: "machine preferences patch must be a plain object",
        code: "validation",
      }),
    );
  }
  return decodePreferencesPatch(raw).pipe(
    Result.mapError(
      (error) =>
        new SettingsError({
          message: `machine preferences patch invalid: ${formatParse(error)}`,
          code: "validation",
        }),
    ),
  );
};
