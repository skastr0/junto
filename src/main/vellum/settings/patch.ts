import { Result, SchemaIssue, Schema } from "effect";
import {
  Settings,
  SettingsError,
  SettingsPatch,
  StationPatch,
  applySettingsPatch,
  type Settings as SettingsValue,
  type SettingsPatch as SettingsPatchValue,
  type StationPatch as StationPatchValue,
} from "@shared/settings";

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
const decodeStationPatch = Schema.decodeUnknownResult(
  StationPatch,
  STRICT_DECODE_OPTIONS,
);

const formatParse = (error: SchemaIssue.ParseError): string =>
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

/** Decode the dedicated local Command Center topology transition. */
export const decodeStationTopologyPatch = (
  raw: unknown,
): Result.Result<StationPatchValue, SettingsError> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Result.fail(
      new SettingsError({
        message: "station topology patch must be a plain object",
        code: "validation",
      }),
    );
  }
  return decodeStationPatch(raw).pipe(
    Result.mapError(
      (error) =>
        new SettingsError({
          message: `station topology patch invalid: ${formatParse(error)}`,
          code: "validation",
        }),
    ),
  );
};
