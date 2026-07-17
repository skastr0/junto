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

const SECTION_KEYS = ["appearance", "canvas", "kernel", "browser", "advanced"] as const;

/** Pick only known keys from a raw section object (no untrusted key sprawl). */
const pickKnown = (
  base: Record<string, unknown>,
  raw: Record<string, unknown>,
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...base };
  for (const key of Object.keys(base)) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      out[key] = raw[key];
    }
  }
  return out;
};

/** Soft-heal known section shapes onto defaults before strict decode. */
const softHeal = (raw: Record<string, unknown>): unknown => {
  const base = defaultSettings() as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = { version: SETTINGS_VERSION };
  for (const key of SECTION_KEYS) {
    const sectionBase = base[key] as Record<string, unknown>;
    const sectionRaw = raw[key];
    out[key] =
      sectionRaw && typeof sectionRaw === "object" && !Array.isArray(sectionRaw)
        ? pickKnown(sectionBase, sectionRaw as Record<string, unknown>)
        : sectionBase;
  }
  return out;
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

  // Floor: only known ladder versions. v1 is the sole supported floor today.
  if (version < 1) {
    return Either.left(
      new SettingsError({
        message: `settings version ${version} is below the supported floor`,
        code: "corrupt",
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
