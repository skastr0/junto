/**
 * Which `junto` CLI a seat is handed: the one its app shipped with, and a
 * checkout's `dist/junto` only when the app bundles none (development). A
 * windowless core hands the CLI its machine package ships beside `bin/node`.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { juntoCliPathPrefixes, machinePackageCliDir } from "../src/main/junto/term/templates/seat-env";

let root: string;
const checkout = () => join(root, "checkout");
const resources = () => join(root, "Junto.app", "Contents", "Resources");
const place = (dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "junto"), "#!/bin/sh\n");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-cli-path-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("the CLI a seat is handed", () => {
  it("a packaged app started inside a checkout hands only its own bundled CLI", () => {
    place(join(checkout(), "dist"));
    place(join(resources(), "bin"));
    expect(juntoCliPathPrefixes(checkout(), resources())).toEqual([join(resources(), "bin")]);
  });

  it("in development, with nothing bundled, the checkout's dist is the CLI", () => {
    place(join(checkout(), "dist"));
    mkdirSync(resources(), { recursive: true });
    expect(juntoCliPathPrefixes(checkout(), resources())).toEqual([join(checkout(), "dist")]);
    expect(juntoCliPathPrefixes(checkout(), undefined)).toEqual([join(checkout(), "dist")]);
  });

  it("an installed app run from / hands its bundled CLI", () => {
    place(join(resources(), "bin"));
    expect(juntoCliPathPrefixes(root, resources())).toEqual([join(resources(), "bin")]);
  });

  it("finds nothing when there is no CLI anywhere", () => {
    expect(juntoCliPathPrefixes(checkout(), resources())).toEqual([]);
  });

  it("a windowless core hands the CLI its machine package ships, through the build selection link", () => {
    const build = join(root, "install", "builds", "b1-darwin-arm64");
    place(join(build, "bin"));
    mkdirSync(join(build, "core"), { recursive: true });
    writeFileSync(join(build, "manifest.json"), "{}");
    const current = join(root, "install", "current");
    symlinkSync(join("builds", "b1-darwin-arm64"), current);
    place(join(checkout(), "dist"));
    const packageBin = machinePackageCliDir(join(current, "core", "junto.cjs"));
    expect(packageBin).toBe(join(current, "bin"));
    expect(juntoCliPathPrefixes(checkout(), undefined, packageBin)).toEqual([join(current, "bin")]);
  });

  it("an entry outside a machine package names no package CLI", () => {
    place(join(root, "pkg", "bin"));
    mkdirSync(join(root, "pkg", "core"), { recursive: true });
    expect(machinePackageCliDir(join(root, "pkg", "core", "junto.cjs"))).toBeUndefined();
  });
});
