import { expect, it } from "vitest";
import { decodeMachineReleaseCatalog, getCompiledMachineReleaseCatalog, MACHINE_RELEASE_ORIGIN, MAX_MACHINE_ARCHIVE_BYTES } from "../src/shared/machine-release";

const catalog = () => ({ schema: "junto/machine-release/v1", build: "a".repeat(64), appVersion: "0.7.0", origin: MACHINE_RELEASE_ORIGIN, archives: [{ target: "darwin-arm64", archivePath: `/machines/${"a".repeat(64)}/darwin-arm64.tar.gz`, archiveBytes: 1, archiveSha256: "b".repeat(64), manifestSha256: "c".repeat(64) }] });

it("admits more target names without introducing alternate origins or mutable paths", () => {
  const pins = catalog();
  const nextTarget = { ...pins.archives[0], target: "linux-arm64", archivePath: `/machines/${pins.build}/linux-arm64.tar.gz` };
  expect(decodeMachineReleaseCatalog({ ...pins, archives: [...pins.archives, nextTarget] }).archives).toHaveLength(2);
  expect(() => decodeMachineReleaseCatalog({ ...pins, origin: "https://other.invalid" })).toThrow();
  expect(() => decodeMachineReleaseCatalog({ ...pins, archives: [...pins.archives, pins.archives[0]] })).toThrow(/repeats/);
  expect(() => decodeMachineReleaseCatalog({ ...pins, archives: [{ ...pins.archives[0], archivePath: "/machines/other/darwin-arm64.tar.gz" }] })).toThrow(/build and target/);
  expect(() => decodeMachineReleaseCatalog({ ...pins, archives: [{ ...pins.archives[0], archiveBytes: MAX_MACHINE_ARCHIVE_BYTES + 1 }] })).toThrow();
  expect(() => decodeMachineReleaseCatalog({ ...pins, archives: [{ ...pins.archives[0], extra: true }] })).toThrow();
});

it("source code has no release pins and never treats an environment value as authority", () => {
  const previous = process.env.JUNTO_MACHINE_RELEASE_CATALOG;
  process.env.JUNTO_MACHINE_RELEASE_CATALOG = JSON.stringify(catalog());
  try { expect(getCompiledMachineReleaseCatalog()).toBeUndefined(); }
  finally { if (previous === undefined) delete process.env.JUNTO_MACHINE_RELEASE_CATALOG; else process.env.JUNTO_MACHINE_RELEASE_CATALOG = previous; }
});
