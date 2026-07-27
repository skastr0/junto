import { Either, ParseResult, Schema } from "effect";
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

const decodeSettings = Schema.decodeUnknownEither(Settings);
const decodeSettingsPatch = Schema.decodeUnknownEither(SettingsPatch);
const decodeStationPatch = Schema.decodeUnknownEither(StationPatch);

const formatParse = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

export const decodePatchInput = (
  raw: unknown,
): Either.Either<SettingsPatchValue, SettingsError> =>
  decodeSettingsPatch(raw).pipe(
    Either.mapLeft(
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
): Either.Either<SettingsValue, SettingsError> => {
  const merged = applySettingsPatch(current, patch);
  return decodeSettings(merged).pipe(
    Either.mapLeft(
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
): Either.Either<StationPatchValue, SettingsError> => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return Either.left(
      new SettingsError({
        message: "station topology patch must be a plain object",
        code: "validation",
      }),
    );
  }
  return decodeStationPatch(raw).pipe(
    Either.mapLeft(
      (error) =>
        new SettingsError({
          message: `station topology patch invalid: ${formatParse(error)}`,
          code: "validation",
        }),
    ),
  );
};
