#!/usr/bin/env bun
/**
 * Bump the package.json product version (electron-builder / CFBundle source).
 *
 *   bun scripts/bump-version.ts              # patch  X.Y.Z → X.Y.(Z+1)
 *   bun scripts/bump-version.ts --minor      #         X.Y.Z → X.(Y+1).0
 *   bun scripts/bump-version.ts --major      #         X.Y.Z → (X+1).0.0
 *   bun scripts/bump-version.ts --set 0.2.0  # exact
 *   bun scripts/bump-version.ts --dry-run
 *
 * Does not tag, build, notarize, or publish. Publishing lives in the private distribution repository.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;

export type BumpKind = "patch" | "minor" | "major" | { readonly set: string };

export type BumpResult = {
  readonly previous: string;
  readonly next: string;
  readonly packageJsonPath: string;
  readonly dryRun: boolean;
};

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const defaultPackageJsonPath = path.join(repoRoot, "package.json");

export const parseSemver = (value: string): readonly [number, number, number] => {
  const match = SEMVER.exec(value.trim());
  if (match === null) {
    throw new Error(`invalid semantic version (need X.Y.Z): ${value}`);
  }
  return [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ] as const;
};

export const formatSemver = (
  major: number,
  minor: number,
  patch: number,
): string => `${major}.${minor}.${patch}`;

export const nextVersion = (current: string, kind: BumpKind): string => {
  if (typeof kind === "object") {
    parseSemver(kind.set);
    return kind.set.trim();
  }
  const [major, minor, patch] = parseSemver(current);
  if (kind === "major") return formatSemver(major + 1, 0, 0);
  if (kind === "minor") return formatSemver(major, minor + 1, 0);
  return formatSemver(major, minor, patch + 1);
};

const readPackageVersion = (packageJsonPath: string): { readonly raw: string; readonly version: string } => {
  const raw = readFileSync(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw) as { readonly version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error(`${packageJsonPath} is missing a string version`);
  }
  parseSemver(parsed.version);
  return { raw, version: parsed.version };
};

/** Replace only the top-level "version" field; preserve formatting/trailing newline. */
export const replacePackageVersion = (
  raw: string,
  next: string,
): string => {
  const replaced = raw.replace(
    /^(\s*"version"\s*:\s*")([^"]+)(")/mu,
    `$1${next}$3`,
  );
  if (replaced === raw) {
    throw new Error('could not locate top-level "version" field in package.json');
  }
  return replaced;
};

export const bumpPackageVersion = (input: {
  readonly packageJsonPath?: string;
  readonly kind: BumpKind;
  readonly dryRun?: boolean;
}): BumpResult => {
  const packageJsonPath = input.packageJsonPath ?? defaultPackageJsonPath;
  const { raw, version: previous } = readPackageVersion(packageJsonPath);
  const next = nextVersion(previous, input.kind);
  if (previous === next) {
    throw new Error(`version is already ${next}`);
  }
  const dryRun = input.dryRun === true;
  if (!dryRun) {
    writeFileSync(packageJsonPath, replacePackageVersion(raw, next), "utf8");
  }
  return { previous, next, packageJsonPath, dryRun };
};

const parseArgs = (
  argv: ReadonlyArray<string>,
): { readonly kind: BumpKind; readonly dryRun: boolean } => {
  let kind: BumpKind = "patch";
  let dryRun = false;
  let kindSet = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--patch" || arg === "--minor" || arg === "--major") {
      if (kindSet) throw new Error("only one of --patch|--minor|--major|--set");
      kind = arg.slice(2) as "patch" | "minor" | "major";
      kindSet = true;
      continue;
    }
    if (arg === "--set") {
      if (kindSet) throw new Error("only one of --patch|--minor|--major|--set");
      const value = argv[++i];
      if (value === undefined || value.length === 0) {
        throw new Error("--set requires X.Y.Z");
      }
      kind = { set: value };
      kindSet = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      process.stdout.write(
        "usage: bun scripts/bump-version.ts [--patch|--minor|--major|--set X.Y.Z] [--dry-run]\n",
      );
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { kind, dryRun };
};

const main = (): void => {
  const { kind, dryRun } = parseArgs(process.argv.slice(2));
  const result = bumpPackageVersion({ kind, dryRun });
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        previous: result.previous,
        next: result.next,
        dryRun: result.dryRun,
        packageJsonPath: result.packageJsonPath,
        nextSteps: [
          "commit the version bump (chore(release): bump X.Y.Z)",
          "bun run app:build:ship",
          "bun run mac:release:publish",
        ],
      },
      null,
      2,
    )}\n`,
  );
};

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      )}\n`,
    );
    process.exitCode = 1;
  }
}
