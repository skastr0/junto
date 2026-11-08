import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { copyFile, lstat, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeMachineReleaseCatalog, type MachineReleaseCatalog } from "../src/shared/machine-release";
import { readPackagedMachineReleaseCatalog } from "./machine-release-catalog";

const regularFile = async (file: string) => {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new Error("machine release artifact must be an unlinked regular file");
  return info;
};
const directory = async (file: string) => {
  const info = await lstat(file);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("machine release directory must not be a link");
};

export const auditMachineReleaseApp = async (appPath: string, expected: { readonly build?: string; readonly appVersion?: string } = {}): Promise<MachineReleaseCatalog> => {
  const embedded = path.join(appPath, "Contents/Resources/machines");
  try { await lstat(embedded); throw new Error("release app must never embed machine bundles"); }
  catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
  const catalog = readPackagedMachineReleaseCatalog(appPath);
  if (expected.build !== undefined && catalog.build !== expected.build || expected.appVersion !== undefined && catalog.appVersion !== expected.appVersion) throw new Error("compiled machine pins do not match this app build");
  return catalog;
};

/** Publication metadata is admitted against pins extracted from packaged code. */
export const verifyMachineReleaseArtifacts = async (appPath: string, releaseRoot: string): Promise<MachineReleaseCatalog> => {
  const compiled = await auditMachineReleaseApp(appPath);
  await directory(releaseRoot);
  const metadataPath = path.join(releaseRoot, "machine-release-catalog.json");
  await regularFile(metadataPath);
  const catalog = decodeMachineReleaseCatalog(JSON.parse(await readFile(metadataPath, "utf8")));
  if (JSON.stringify(catalog) !== JSON.stringify(compiled)) throw new Error("publication metadata differs from the qualified app's compiled pins");
  await directory(path.join(releaseRoot, "machines"));
  await directory(path.join(releaseRoot, "machines", catalog.build));
  for (const archive of catalog.archives) {
    const file = path.join(releaseRoot, archive.archivePath.slice(1));
    const info = await regularFile(file);
    if (info.size !== archive.archiveBytes) throw new Error("machine release archive size differs from compiled pins");
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    if (hash.digest("hex") !== archive.archiveSha256) throw new Error("machine release archive digest differs from compiled pins");
  }
  return compiled;
};

/** The notarized ZIP is publication authority; a loose app cannot substitute pins. */
export const assertMachineReleaseAppMatchesZip = async (appPath: string, zipPath: string): Promise<void> => {
  await regularFile(zipPath);
  const asarPath = path.join(appPath, "Contents/Resources/app.asar");
  const info = await regularFile(asarPath);
  if (info.size > 512 * 1024 * 1024) throw new Error("publication app archive exceeds verification bound");
  const zipped = execFileSync("unzip", ["-p", zipPath, "Junto.app/Contents/Resources/app.asar"], { maxBuffer: 512 * 1024 * 1024, timeout: 120_000 });
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(asarPath)) hash.update(chunk);
  if (zipped.length !== info.size || createHash("sha256").update(zipped).digest("hex") !== hash.digest("hex")) throw new Error("publication app code differs from the notarized ZIP");
};

export const stageMachineReleasePublication = async (appPath: string, source: string, destination: string): Promise<MachineReleaseCatalog> => {
  const catalog = await verifyMachineReleaseArtifacts(appPath, source);
  await directory(destination);
  await mkdir(path.join(destination, "machines", catalog.build), { recursive: true });
  for (const archive of catalog.archives) await copyFile(path.join(source, archive.archivePath.slice(1)), path.join(destination, archive.archivePath.slice(1)), constants.COPYFILE_EXCL);
  await copyFile(path.join(source, "machine-release-catalog.json"), path.join(destination, "machine-release-catalog.json"), constants.COPYFILE_EXCL);
  await verifyMachineReleaseArtifacts(appPath, destination);
  return catalog;
};

if (import.meta.main) {
  const [app, source, destination] = process.argv.slice(2);
  if (!app || !source || !destination) throw new Error("usage: machine-release-publication.ts APP SOURCE DESTINATION");
  process.stdout.write(JSON.stringify(await stageMachineReleasePublication(app, source, destination)) + "\n");
}
