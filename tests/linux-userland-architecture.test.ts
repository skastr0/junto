/**
 * Negative architecture tests: product sources must not reintroduce the
 * retired privileged Linux install lane.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const walkTs = async (
  directory: string,
  out: string[] = [],
): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "out" || entry.name === "dist") {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) await walkTs(full, out);
    else if (entry.isFile() && /\.(ts|tsx|mjs|js)$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
};

describe("Linux userland architecture negatives", () => {
  it("deploy product code never installs under /opt/vellum or /opt/Junto", async () => {
    const files = [
      path.join(ROOT, "src/main/vellum-command/hosts/deploy-linux.ts"),
      path.join(ROOT, "src/main/vellum-command/ssh/remote-plan.ts"),
      path.join(ROOT, "src/main/vellum-command/hosts/linux-release-admission.ts"),
      path.join(ROOT, "src/main/vellum-command/hosts/linux-release-feed.ts"),
      path.join(ROOT, "src/main/vellum-command/hosts/remote-deployment.ts"),
      path.join(ROOT, "src/main/vellum-command/hosts/deploy-configured-remote.ts"),
    ];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/\/opt\/[Vv]ellum\b/u);
      expect(source, file).not.toMatch(/\bdpkg(?:-deb|-query)?\b/u);
      expect(source, file).not.toMatch(/\bapt-get\b/u);
      expect(source, file).not.toMatch(/vellum-release-bridge/u);
      expect(source, file).not.toMatch(/vellum-release-installer/u);
      expect(source, file).not.toMatch(/admin-password/u);
    }
  });

  it("product barrels never re-export the release bridge/installer", async () => {
    const barrels = [
      path.join(ROOT, "src/main/vellum-command/hosts/index.ts"),
      path.join(ROOT, "src/main/vellum-command/ssh/index.ts"),
      path.join(ROOT, "src/shared"),
    ];
    for (const entry of barrels) {
      const files = entry.endsWith(".ts")
        ? [entry]
        : (await readdir(entry))
          .filter((name) => name.endsWith(".ts"))
          .map((name) => path.join(entry, name));
      for (const file of files) {
        const source = await readFile(file, "utf8");
        expect(source, file).not.toMatch(/vellum-release-bridge/u);
        expect(source, file).not.toMatch(/vellum-release-installer/u);
        expect(source, file).not.toMatch(/linux-release-bridge/u);
        expect(source, file).not.toMatch(/linux-release-installer/u);
      }
    }
  });

  it("renderer sources never call sudo", async () => {
    const files = await walkTs(path.join(ROOT, "src/renderer"));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const source = await readFile(file, "utf8");
      expect(source, file).not.toMatch(/\bsudo\b/u);
      expect(source, file).not.toMatch(/admin-password/u);
      expect(source, file).not.toMatch(/vellum-release-bridge/u);
    }
  });

  it("package.json keeps only the Linux dir target", async () => {
    const pkg = JSON.parse(
      await readFile(path.join(ROOT, "package.json"), "utf8"),
    ) as { build: { linux: { target: unknown } } };
    expect(pkg.build.linux.target).toEqual(["dir"]);
    const serialized = JSON.stringify(pkg.build.linux);
    expect(serialized).not.toMatch(/"deb"/u);
    expect(serialized).not.toMatch(/release-bridge|release-installer|\/opt\//u);
  });
});
