/**
 * Which `junto` CLI a seat is handed: the one its app shipped with, and a
 * checkout's `dist/junto` only when the app bundles none (development).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { juntoCliPathPrefixes } from "../src/main/junto/term/templates/seat-env";

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
});
