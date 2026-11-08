// FROZEN CONTRACT: src/shared/machine-release.ts
// Version: 1.0.0, approved by remote-security, 2026-10-09.
// Consumers: machine acquisition, release packaging and publication.
// Changes go through the machine build contract owner and security review.
import { Schema } from "effect";

export const MACHINE_RELEASE_ORIGIN = "https://releases.juntoagents.com" as const;
export const MAX_MACHINE_ARCHIVE_BYTES = 299_999_999;
export const MAX_MACHINE_UNPACKED_BYTES = 512 * 1024 * 1024;
export const MAX_MACHINE_ARCHIVE_FILES = 129;
export const MAX_MACHINE_ARCHIVE_PATH_BYTES = 255;
const Digest = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{64}$/)));
export const MachineReleaseTarget = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)+$/)),
);
export const MachineReleaseArchive = Schema.Struct({
  target: MachineReleaseTarget,
  archivePath: Schema.String,
  archiveBytes: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isBetween({ minimum: 1, maximum: MAX_MACHINE_ARCHIVE_BYTES }))),
  archiveSha256: Digest,
  manifestSha256: Digest,
});
export type MachineReleaseArchive = typeof MachineReleaseArchive.Type;
export const MachineReleaseCatalog = Schema.Struct({
  schema: Schema.Literal("junto/machine-release/v1"),
  build: Digest,
  appVersion: Schema.String.pipe(Schema.check(Schema.isPattern(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/))),
  origin: Schema.Literal(MACHINE_RELEASE_ORIGIN),
  archives: Schema.Array(MachineReleaseArchive).pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(32))),
});
export type MachineReleaseCatalog = typeof MachineReleaseCatalog.Type;

export const decodeMachineReleaseCatalog = (value: unknown): MachineReleaseCatalog => {
  const catalog = Schema.decodeUnknownSync(MachineReleaseCatalog, { onExcessProperty: "error" })(value);
  const targets = new Set<string>();
  for (const archive of catalog.archives) {
    if (targets.has(archive.target)) throw new Error("machine release catalog repeats a target");
    targets.add(archive.target);
    if (archive.archivePath !== `/machines/${catalog.build}/${archive.target}.tar.gz`) throw new Error("machine archive path does not match its build and target");
  }
  return catalog;
};

declare const __JUNTO_MACHINE_RELEASE_CATALOG__: unknown;
/** Only authenticated release code supplies pins. Source and Preview stay local. */
export const getCompiledMachineReleaseCatalog = (): MachineReleaseCatalog | undefined => {
  const compiled = typeof __JUNTO_MACHINE_RELEASE_CATALOG__ === "undefined" ? undefined : __JUNTO_MACHINE_RELEASE_CATALOG__;
  if (compiled === undefined) return undefined;
  if (typeof compiled !== "string" || !compiled.startsWith("JUNTO_MACHINE_RELEASE_CATALOG:")) throw new Error("compiled machine release pins are malformed");
  return decodeMachineReleaseCatalog(JSON.parse(atob(compiled.slice("JUNTO_MACHINE_RELEASE_CATALOG:".length).replaceAll("-", "+").replaceAll("_", "/"))));
};
