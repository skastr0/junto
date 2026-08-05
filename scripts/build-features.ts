import {
  ALL_FEATURES,
  FEATURE_CATALOG,
  SHIP_FEATURES,
  type FeatureKey,
  type FeatureSet,
} from "../src/shared/feature-catalog";

export type FeatureProfileName = "ship" | "all-on";

const FEATURE_KEYS = Object.keys(FEATURE_CATALOG) as ReadonlyArray<FeatureKey>;

const featureProfileName = (
  env: Readonly<Record<string, string | undefined>>,
): FeatureProfileName => {
  const raw = env.VELLUM_FEATURE_PROFILE?.trim() || "ship";
  if (raw === "ship" || raw === "all-on") return raw;
  throw new Error(
    `VELLUM_FEATURE_PROFILE must be ship or all-on; received ${JSON.stringify(raw)}`,
  );
};

const parseOverride = (
  envName: string,
  raw: string | undefined,
): boolean | undefined => {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "0") return false;
  if (raw === "1") return true;
  throw new Error(`${envName} must be 0 or 1; received ${JSON.stringify(raw)}`);
};

export interface ResolvedBuildFeatures {
  readonly profile: FeatureProfileName;
  readonly features: FeatureSet;
  readonly overrides: ReadonlyArray<FeatureKey>;
  readonly fingerprint: string;
}

export const featureFingerprint = (features: FeatureSet): string =>
  FEATURE_KEYS.map((key) => `${key}=${features[key] ? "1" : "0"}`).join(",");

export const resolveBuildFeatures = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ResolvedBuildFeatures => {
  const profile = featureProfileName(env);
  const baseline = profile === "all-on" ? ALL_FEATURES : SHIP_FEATURES;
  const features = { ...baseline } as Record<FeatureKey, boolean>;
  const overrides: FeatureKey[] = [];

  for (const key of FEATURE_KEYS) {
    const override = parseOverride(FEATURE_CATALOG[key].env, env[FEATURE_CATALOG[key].env]);
    if (override === undefined) continue;
    features[key] = override;
    overrides.push(key);
  }

  return {
    profile,
    features,
    overrides,
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
        fingerprint: resolved.fingerprint,
      }),
    );
  } else {
    throw new Error(
      "usage: bun scripts/build-features.ts --bun-define-args|--ship-deviation|--receipt",
    );
  }
}
