/**
 * Local mirror of packager result shapes — no import from @skastr0/prism-packager.
 * Electron main is Node; packager is Bun-only TS and must never be required in-process.
 */

export type HarnessId = string;
export type HarnessScope = "global" | "project";

export type DesiredFile = {
  readonly targetPath: string;
  readonly content: string;
  readonly mode?: number;
  readonly plugin: string;
};

export type DesiredRegion = {
  readonly kind: string;
  readonly targetPath: string;
  readonly content?: string;
  readonly [key: string]: unknown;
};

export type PackageWriteOperation = {
  readonly type: "write" | "skip" | "prune" | "drift";
  readonly path: string;
  readonly reason: string;
};

export type PackageResult = {
  readonly target: HarnessId;
  readonly packageId: string;
  readonly packageRoot: string;
  readonly planRoot: string;
  readonly activationPath?: string;
  readonly manifestPath?: string;
  readonly operations: ReadonlyArray<PackageWriteOperation>;
  readonly compileFiles: ReadonlyArray<DesiredFile>;
  readonly compileRegions: ReadonlyArray<DesiredRegion>;
};
