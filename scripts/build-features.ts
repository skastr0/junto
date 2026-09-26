import {
  ALL_FEATURES,
  FEATURE_CATALOG,
  SHIP_FEATURES,
  experimentalFeatureSpec,
  featureTierWord,
  type FeatureKey,
  type FeatureSet,
  type FeatureTier,
} from "../src/shared/feature-catalog";

export type FeatureProfileName = "ship" | "all-on";

const FEATURE_KEYS = Object.keys(FEATURE_CATALOG) as ReadonlyArray<FeatureKey>;

const featureProfileName = (
  env: Readonly<Record<string, string | undefined>>,
): FeatureProfileName => {
  const raw = env.JUNTO_FEATURE_PROFILE?.trim() || "ship";
  if (raw === "ship" || raw === "all-on") return raw;
  throw new Error(
    `JUNTO_FEATURE_PROFILE must be ship or all-on; received ${JSON.stringify(raw)}`,
  );
};

const parseOverride = (
  key: FeatureKey,
  raw: string | undefined,
): FeatureTier | undefined => {
  const envName = FEATURE_CATALOG[key].env;
  if (raw === undefined || raw === "") return undefined;
  if (raw === "0") return false;
  if (raw === "1") return true;
  if (raw === "experimental") return "experimental";
  throw new Error(
    `${envName} must be 0, 1 or experimental; received ${JSON.stringify(raw)}`,
  );
};

/**
 * The middle tier needs a runtime toggle to be honest: a feature compiled in
 * with no way to turn it on is dead weight that the receipt would call
 * experimental. Only catalog entries that declare `experimental` may take it.
 */
const assertTierAdmitted = (key: FeatureKey, tier: FeatureTier): void => {
  if (tier === "experimental" && experimentalFeatureSpec(key) === undefined) {
    throw new Error(
      `${FEATURE_CATALOG[key].env}=experimental is not available: ${key} has no Settings toggle`,
    );
  }
};

export interface ResolvedBuildFeatures {
  readonly profile: FeatureProfileName;
  readonly features: FeatureSet;
  readonly overrides: ReadonlyArray<FeatureKey>;
  /** Compiled in but off until the operator turns them on in Settings. */
  readonly experimental: ReadonlyArray<FeatureKey>;
  readonly fingerprint: string;
}

const FINGERPRINT_TIER: Readonly<Record<ReturnType<typeof featureTierWord>, string>> = {
  on: "1",
  off: "0",
  experimental: "x",
};

/** One token per feature: 1 on, 0 compiled out, x experimental. */
export const featureFingerprint = (features: FeatureSet): string =>
  FEATURE_KEYS.map(
    (key) => `${key}=${FINGERPRINT_TIER[featureTierWord(features[key])]}`,
  ).join(",");

export const resolveBuildFeatures = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedBuildFeatures => {
  const profile = featureProfileName(env);
  const baseline = profile === "all-on" ? ALL_FEATURES : SHIP_FEATURES;
  const features = { ...baseline } as Record<FeatureKey, FeatureTier>;
  const overrides: FeatureKey[] = [];

  for (const key of FEATURE_KEYS) {
    const override = parseOverride(key, env[FEATURE_CATALOG[key].env]);
    if (override === undefined) continue;
    features[key] = override;
    overrides.push(key);
  }
  for (const key of FEATURE_KEYS) assertTierAdmitted(key, features[key]);

  return {
    profile,
    features,
    overrides,
    experimental: FEATURE_KEYS.filter((key) => features[key] === "experimental"),
    fingerprint: featureFingerprint(features),
  };
};

export const featureViteDefines = (
  resolved: ResolvedBuildFeatures,
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    FEATURE_KEYS.map((key) => [
      FEATURE_CATALOG[key].define,
      JSON.stringify(resolved.features[key]),
    ]),
  );

export const featureBunDefineArgs = (
  resolved: ResolvedBuildFeatures,
): ReadonlyArray<string> =>
  FEATURE_KEYS.map(
    (key) =>
      `--define=${FEATURE_CATALOG[key].define}=${JSON.stringify(resolved.features[key])}`,
  );

if (import.meta.main) {
  const resolved = resolveBuildFeatures(process.env);
  const command = process.argv[2];
  if (command === "--bun-define-args") {
    process.stdout.write(`${featureBunDefineArgs(resolved).join("\n")}\n`);
  } else if (command === "--ship-deviation") {
    const deviations = [
      ...(resolved.profile === "ship" ? [] : [`profile=${resolved.profile}`]),
      ...resolved.overrides.map((key) => FEATURE_CATALOG[key].env),
    ];
    process.stdout.write(deviations.join(","));
  } else if (command === "--receipt") {
    process.stdout.write(
      JSON.stringify({
        profile: resolved.profile,
        overrides: resolved.overrides,
        experimental: resolved.experimental,
        fingerprint: resolved.fingerprint,
      }),
    );
  } else {
    throw new Error(
      "usage: bun scripts/build-features.ts --bun-define-args|--ship-deviation|--receipt",
    );
  }
}
