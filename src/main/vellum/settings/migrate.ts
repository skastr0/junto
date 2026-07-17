import { Either, ParseResult, Schema } from "effect";
import {
  SETTINGS_VERSION,
  Settings,
  SettingsError,
  SettingsPatch,
  applySettingsPatch,
  defaultSettings,
  type Settings as SettingsT,
  type SettingsPatch as SettingsPatchT,
} from "@shared/settings";

// Version ladder for the settings document. v1 is the floor; unknown future
// versions fail closed (do not invent a downgrade). Partial / missing fields
// on a known version soft-heal onto defaults before strict decode.

const decodeSettings = Schema.decodeUnknownEither(Settings);
const decodeSettingsPatch = Schema.decodeUnknownEither(SettingsPatch);

/** Soft-heal known section shapes onto defaults before strict decode. */
const softHeal = (raw: Record<string, unknown>): unknown => {
  const base = defaultSettings();
  const appearance =
    raw.appearance && typeof raw.appearance === "object" && !Array.isArray(raw.appearance)
      ? { ...base.appearance, ...(raw.appearance as object) }
      : base.appearance;
  const canvas =
    raw.canvas && typeof raw.canvas === "object" && !Array.isArray(raw.canvas)
      ? { ...base.canvas, ...(raw.canvas as object) }
      : base.canvas;
  const kernel =
    raw.kernel && typeof raw.kernel === "object" && !Array.isArray(raw.kernel)
      ? { ...base.kernel, ...(raw.kernel as object) }
      : base.kernel;
  const browser =
    raw.browser && typeof raw.browser === "object" && !Array.isArray(raw.browser)
      ? { ...base.browser, ...(raw.browser as object) }
      : base.browser;
  const advanced =
    raw.advanced && typeof raw.advanced === "object" && !Array.isArray(raw.advanced)
      ? { ...base.advanced, ...(raw.advanced as object) }
      : base.advanced;

  return {
    version: SETTINGS_VERSION,
    appearance,
    canvas,
    kernel,
    browser,
    advanced,
  };
};

const formatParse = (error: ParseResult.ParseError): string =>
  ParseResult.TreeFormatter.formatErrorSync(error);

/**
 * Decode + migrate a JSON value into Settings v1.
 * Corrupt JSON is the caller's responsibility (throw before here).
 */
export const migrateSettingsDocument = (
  raw: unknown,
): Either.Either<SettingsT, SettingsError> => {
  if (raw === null || raw === undefined) {
    return Either.right(defaultSettings());
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return Either.left(
      new SettingsError({
        message: "settings document must be a JSON object",
        code: "corrupt",
      }),
    );
  }

  const record = raw as Record<string, unknown>;
  const version = record.version;

  if (version === undefined) {
    return decodeSettings(softHeal(record)).pipe(
      Either.mapLeft(
        (error) =>
          new SettingsError({
            message: `settings decode failed: ${formatParse(error)}`,
            code: "validation",
          }),
      ),
    );
  }

  if (typeof version !== "number" || !Number.isInteger(version)) {
    return Either.left(
      new SettingsError({
        message: `settings version must be an integer, got ${String(version)}`,
        code: "corrupt",
      }),
    );
  }

  if (version > SETTINGS_VERSION) {
    return Either.left(
      new SettingsError({
        message: `settings version ${version} is newer than supported ${SETTINGS_VERSION}`,
        code: "unsupported",
      }),
    );
  }

  // Future ladder steps (version < SETTINGS_VERSION) land above softHeal.
  return decodeSettings(softHeal(record)).pipe(
    Either.mapLeft(
      (error) =>
        new SettingsError({
          message: `settings decode failed: ${formatParse(error)}`,
          code: "validation",
        }),
    ),
  );
};

export const decodePatchInput = (
  raw: unknown,
): Either.Either<SettingsPatchT, SettingsError> =>
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
  current: SettingsT,
  patch: SettingsPatchT,
): Either.Either<SettingsT, SettingsError> => {
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
