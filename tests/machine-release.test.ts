import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { createPackage } from "@electron/asar";
import { afterEach, expect, it } from "vitest";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { decodeMachineReleaseCatalog, getCompiledMachineReleaseCatalog, MACHINE_RELEASE_ORIGIN, MAX_MACHINE_ARCHIVE_BYTES, type MachineReleaseCatalog } from "../src/shared/machine-release";
import { archiveMachineBundle, machineTarHeader } from "../scripts/machine-release";
import { extractMachineReleaseCatalog, machineReleaseCatalogConstant } from "../scripts/machine-release-catalog";
import { auditMachineReleaseApp, verifyMachineReleaseArtifacts } from "../scripts/machine-release-publication";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const scratch = async () => { const root = await mkdtemp(path.join(tmpdir(), "junto-release-archives-")); roots.push(root); return root; };
const catalog = (): MachineReleaseCatalog => ({ schema: "junto/machine-release/v1", build: "a".repeat(64), appVersion: "0.7.0", origin: MACHINE_RELEASE_ORIGIN, archives: [{ target: "darwin-arm64", archivePath: `/machines/${"a".repeat(64)}/darwin-arm64.tar.gz`, archiveBytes: 3, archiveSha256: createHash("sha256").update("zip").digest("hex"), manifestSha256: "b".repeat(64) }] });

it("writes deterministic flat regular-file archives and refuses changed manifest inputs", async () => {
  const root = await scratch(), bundle = path.join(root, "bundle");
  await mkdir(path.join(bundle, "bin"), { recursive: true }); await mkdir(path.join(bundle, "core"));
  for (const file of ["bin/node", "bin/junto", "core/junto.cjs"]) { await writeFile(path.join(bundle, file), file); await chmod(path.join(bundle, file), file.startsWith("bin/") ? 0o755 : 0o644); }
  await writeFile(path.join(bundle, "manifest.json"), JSON.stringify({ build: "a".repeat(64), target: "linux-x64", node: "26.10.0", appVersion: "0.7.0", files: await machineBundleFiles(bundle) })); await chmod(path.join(bundle, "manifest.json"), 0o644);
  const first = await archiveMachineBundle(bundle, path.join(root, "one.tar.gz"));
  const second = await archiveMachineBundle(bundle, path.join(root, "two.tar.gz"));
  expect(first).toEqual(second);
  const tar = gunzipSync(await readFile(path.join(root, "one.tar.gz")));
  const names: string[] = [];
  for (let offset = 0; tar[offset] !== 0;) { const header = tar.subarray(offset, offset + 512); names.push(header.subarray(0, 100).toString().split("\0")[0]!); expect(header[156]).toBe(48); const bytes = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/, ""), 8); offset += 512 + Math.ceil(bytes / 512) * 512; }
  expect(names).toEqual(["bin/junto", "bin/node", "core/junto.cjs", "manifest.json"]);
  await writeFile(path.join(bundle, "bin/node"), "changed");
  await expect(archiveMachineBundle(bundle, path.join(root, "wrong.tar.gz"))).rejects.toThrow(/manifest/);
  for (const unsafe of ["../node", "/node", "bin/../node", "bin/./node", "node".repeat(80)]) expect(() => machineTarHeader(unsafe, 1, 0o755)).toThrow(/path/);
});

it("uses the same compiled constant for runtime and publication admission", async () => {
  const root = await scratch(), entry = path.join(root, "main.ts"), out = path.join(root, "index.cjs");
  await writeFile(entry, `export {getCompiledMachineReleaseCatalog} from ${JSON.stringify(path.resolve("src/shared/machine-release.ts"))};`);
  const pins = catalog();
  expect(getCompiledMachineReleaseCatalog()).toBeUndefined();
  execFileSync("bun", ["build", entry, "--target=node", "--format=cjs", "--minify", "--outfile", out, `--define=__JUNTO_MACHINE_RELEASE_CATALOG__=${JSON.stringify(machineReleaseCatalogConstant(pins))}`], { stdio: "pipe" });
  expect(extractMachineReleaseCatalog(await readFile(out))).toEqual(pins);
  expect(createRequire(import.meta.url)(out).getCompiledMachineReleaseCatalog()).toEqual(pins);
  const other = { ...pins, build: "c".repeat(64), archives: pins.archives.map(archive => ({ ...archive, archivePath: archive.archivePath.replace("a".repeat(64), "c".repeat(64)) })) };
  expect(() => extractMachineReleaseCatalog(Buffer.from(machineReleaseCatalogConstant(pins) + "\n" + machineReleaseCatalogConstant(other)))).toThrow(/repeats/);
});

it("anchors release files to packaged pins and refuses embedded bundles or detached metadata", async () => {
  const root = await scratch(), app = path.join(root, "Junto.app"), packed = path.join(root, "packed"), pins = catalog();
  await mkdir(path.join(packed, "out/main"), { recursive: true }); await writeFile(path.join(packed, "out/main/index.js"), `const pins=${JSON.stringify(machineReleaseCatalogConstant(pins))};`);
  await mkdir(path.join(app, "Contents/Resources"), { recursive: true }); await createPackage(packed, path.join(app, "Contents/Resources/app.asar"));
  await mkdir(path.join(root, "machines", pins.build), { recursive: true }); await writeFile(path.join(root, pins.archives[0]!.archivePath.slice(1)), "zip"); await writeFile(path.join(root, "machine-release-catalog.json"), JSON.stringify(pins));
  await expect(verifyMachineReleaseArtifacts(app, root)).resolves.toEqual(pins);
  await writeFile(path.join(root, "machine-release-catalog.json"), JSON.stringify({ ...pins, appVersion: "0.8.0" }));
  await expect(verifyMachineReleaseArtifacts(app, root)).rejects.toThrow(/compiled pins/);
  await writeFile(path.join(root, "machine-release-catalog.json"), JSON.stringify(pins)); await writeFile(path.join(root, pins.archives[0]!.archivePath.slice(1)), "bad");
  await expect(verifyMachineReleaseArtifacts(app, root)).rejects.toThrow(/digest/);
  await writeFile(path.join(root, pins.archives[0]!.archivePath.slice(1)), "z");
  await expect(verifyMachineReleaseArtifacts(app, root)).rejects.toThrow(/size/);
  await mkdir(path.join(app, "Contents/Resources/machines")); await expect(auditMachineReleaseApp(app)).rejects.toThrow(/never embed/);
});

it("rejects untrusted origins, duplicate targets, wrong build paths and oversized archives", () => {
  const pins = catalog();
  expect(() => decodeMachineReleaseCatalog({ ...pins, origin: "https://other.invalid" })).toThrow();
  expect(() => decodeMachineReleaseCatalog({ ...pins, archives: [pins.archives[0], pins.archives[0]] })).toThrow(/repeats/);
  expect(() => decodeMachineReleaseCatalog({ ...pins, archives: [{ ...pins.archives[0], archivePath: "/machines/other/darwin-arm64.tar.gz" }] })).toThrow(/build and target/);
  expect(() => decodeMachineReleaseCatalog({ ...pins, archives: [{ ...pins.archives[0], archiveBytes: MAX_MACHINE_ARCHIVE_BYTES + 1 }] })).toThrow();
});
