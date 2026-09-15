/**
 * Node-owned isolated harness launch for capture and generated-canvas E2E.
 * Renderer must not import this module (uses node:fs / path).
 *
 * operatorHome is injected by the caller (os.homedir() at the Node boundary).
 * credentialFiles are the only operator files that may be copied.
 */
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import {
  HARNESS_ISOLATION,
  buildIsolatedHarnessLaunch,
  isolatedSpawnRuntimeEnv,
  templateFor,
  type HarnessId,
  type IsolatedCaptureRequest,
  type IsolatedHarnessLaunch,
} from "../../../shared/managed-terminal-templates";

const AUTH_SEED_DENIED =
  /(?:^|\/)(?:sessions?|history|settings|config\.toml|transcripts|projects)(?:\/|$)/i;

export type IsolatedAuthSeedResult = {
  readonly copied: readonly string[];
  readonly skipped: readonly string[];
};

/** Copy only declared credential files into a throwaway home. Never history/settings. */
export const seedIsolatedAuthFiles = (input: {
  readonly harness: HarnessId;
  readonly isolatedHome: string;
  readonly operatorHome: string;
}): IsolatedAuthSeedResult => {
  const copied: string[] = [];
  const skipped: string[] = [];
  if (input.operatorHome.length === 0 || input.isolatedHome === input.operatorHome) {
    return { copied, skipped: ["operator-home"] };
  }
  const spec = HARNESS_ISOLATION[input.harness];
  for (const file of spec.credentialFiles) {
    if (
      file.operatorRelative.includes("..") ||
      file.isolatedRelative.includes("..") ||
      AUTH_SEED_DENIED.test(file.operatorRelative) ||
      AUTH_SEED_DENIED.test(file.isolatedRelative)
    ) {
      skipped.push(file.operatorRelative);
      continue;
    }
    const source = join(input.operatorHome, file.operatorRelative);
    const dest = join(input.isolatedHome, file.isolatedRelative);
    const homePrefix = input.isolatedHome.endsWith(sep)
      ? input.isolatedHome
      : `${input.isolatedHome}${sep}`;
    if (dest !== input.isolatedHome && !dest.startsWith(homePrefix)) {
      skipped.push(file.operatorRelative);
      continue;
    }
    if (!existsSync(source) || statSync(source).isDirectory()) {
      skipped.push(file.operatorRelative);
      continue;
    }
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(source, dest);
    copied.push(file.isolatedRelative);
  }
  return { copied, skipped };
};

export type PreparedIsolatedHarnessLaunch = IsolatedHarnessLaunch & {
  readonly seeded: IsolatedAuthSeedResult;
};

/**
 * Overlay + credential-file seed for a throwaway home.
 * Merge `env` onto the sandbox process env. Do not inherit operator HOME.
 * `typedNoticeQualified` is not flipped here.
 */
export const prepareIsolatedHarnessLaunch = (
  input: IsolatedCaptureRequest & { readonly cwd: string },
): PreparedIsolatedHarnessLaunch => {
  mkdirSync(input.isolatedHome, { recursive: true });
  mkdirSync(input.cwd, { recursive: true });
  const launch = buildIsolatedHarnessLaunch(input);
  const seeded = launch.ok
    ? seedIsolatedAuthFiles({
        harness: input.harness,
        isolatedHome: input.isolatedHome,
        operatorHome: input.operatorHome,
      })
    : { copied: [], skipped: [] as const };
  return { ...launch, seeded };
};

/** Directory containing the real harness binary on PATH, if any. */
export const realHarnessBinaryDir = (
  harness: HarnessId,
  pathEnv: string,
): string | undefined => {
  const binary = templateFor(harness).argvSpec.binary;
  if (isAbsolute(binary)) return dirname(binary);
  for (const dir of pathEnv.split(":")) {
    if (dir.length === 0) continue;
    const candidate = join(dir, binary);
    if (existsSync(candidate)) return dir;
  }
  return undefined;
};

/**
 * PATH for a real-harness generated-canvas launch: real binary first, then
 * the sandbox runtime overlay, never operator HOME.
 */
export const isolatedRealHarnessPath = (input: {
  readonly harness: HarnessId;
  readonly operatorPath: string;
  readonly sandboxPath: string;
}): string => {
  const realDir = realHarnessBinaryDir(input.harness, input.operatorPath);
  const runtime = isolatedSpawnRuntimeEnv({ PATH: input.sandboxPath }).PATH ?? input.sandboxPath;
  return realDir === undefined ? runtime : `${realDir}:${runtime}`;
};
