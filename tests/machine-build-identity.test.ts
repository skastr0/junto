import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { buildIdentity } from "../scripts/build-identity";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "junto-build-id-"));
  roots.push(root);
  mkdirSync(join(root, "src")); mkdirSync(join(root, "scripts"));
  for (const file of ["package.json", "bun.lock", "tsconfig.json", "electron.vite.config.ts", "scripts/build-identity.ts", "scripts/build-machine.ts", "scripts/build-features.ts", "scripts/build-standalone-cli.ts", "src/core.ts"]) writeFileSync(join(root,file), file);
  return root;
};

it("identifies the same source bytes across different roots", () => {
  expect(buildIdentity(fixture(), {})).toBe(buildIdentity(fixture(), {}));
});

it("detects an uncommitted source change, dependency change, and build recipe change", () => {
  const root = fixture();
  const original = buildIdentity(root, {});
  for (const file of ["src/core.ts", "bun.lock", "scripts/build-machine.ts"]) {
    const bytes = readFileSync(join(root, file));
    writeFileSync(join(root, file), Buffer.concat([bytes, Buffer.from("changed")]));
    expect(buildIdentity(root, {})).not.toBe(original);
    writeFileSync(join(root, file), bytes);
  }
});

it("ignores unrelated files outside the source and build inputs", () => {
  const root = fixture();
  const original = buildIdentity(root, {});
  writeFileSync(join(root, "receipt.log"), "a machine ran");
  expect(buildIdentity(root, {})).toBe(original);
});
