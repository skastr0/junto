import { readFileSync } from "node:fs";
import path from "node:path";
import { extractFile } from "@electron/asar";
import { decodeMachineReleaseCatalog, type MachineReleaseCatalog } from "../src/shared/machine-release";
import { buildIdentity } from "./build-identity";

const PIN = /JUNTO_MACHINE_RELEASE_CATALOG:([A-Za-z0-9_-]+)/g;
/** This is the actual runtime constant, not a separate audit-only marker. */
export const machineReleaseCatalogConstant = (catalog: MachineReleaseCatalog): string =>
  `JUNTO_MACHINE_RELEASE_CATALOG:${Buffer.from(JSON.stringify(decodeMachineReleaseCatalog(catalog))).toString("base64url")}`;

export const extractMachineReleaseCatalog = (main: Uint8Array): MachineReleaseCatalog | undefined => {
  const matches = [...new Set([...Buffer.from(main).toString("utf8").matchAll(PIN)].map(match => match[1]!))];
  if (matches.length === 0) return undefined;
  if (matches.length !== 1) throw new Error("compiled main repeats its machine release catalog");
  return decodeMachineReleaseCatalog(JSON.parse(Buffer.from(matches[0]!, "base64url").toString("utf8")));
};

export const readPackagedMachineReleaseCatalog = (appPath: string): MachineReleaseCatalog => {
  const main = extractFile(path.join(appPath, "Contents/Resources/app.asar"), "out/main/index.js");
  const catalog = extractMachineReleaseCatalog(main);
  if (catalog === undefined) throw new Error("release app has no compiled machine archive pins");
  return catalog;
};

/** This build input is consumed only by the release compiler, never at runtime. */
export const machineReleaseCatalogForBuild = (root: string, preview: boolean): MachineReleaseCatalog | undefined => {
  if (process.env.JUNTO_MACHINE_RELEASE_BUILD !== "1") return undefined;
  if (preview || process.env.JUNTO_PREVIEW_BUILD === "1" || process.env.JUNTO_CI_SOURCE_PACKAGE === "1") throw new Error("source and Preview builds cannot download machine bundles");
  const catalog = decodeMachineReleaseCatalog(JSON.parse(readFileSync(path.join(root, "dist/machine-release-catalog.json"), "utf8")));
  const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version;
  if (catalog.build !== buildIdentity(root) || catalog.appVersion !== version) throw new Error("machine archive pins do not match this app build");
  return catalog;
};
