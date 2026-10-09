import { appendFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { signMachineBundle } from "../scripts/sign-machine-bundle.mjs";
import { assertMachinePayloadsUnchanged, snapshotMachinePayloads } from "../scripts/machine-payloads.mjs";
import { auditMachinePayloads } from "../scripts/audit-packaged-app";

const signAsync = vi.hoisted(() => vi.fn());
vi.mock("@electron/osx-sign", () => ({ signAsync }));
import signJuntoApp from "../scripts/electron-builder-sign.mjs";

const environment = { JUNTO_MAC_TEAM_ID: "ABCDEFGHIJ", JUNTO_MAC_SIGNING_IDENTITY: "Developer ID Application: Signing Fixture (ABCDEFGHIJ)" };
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("immutable signed machine payloads", () => {
  it("seals signed bytes before app signing, whose ignore callback preserves both targets", async () => {
    const scratch = await realpath(await mkdtemp(path.join(tmpdir(), "junto-signed-payload-")));
    const app = path.join(scratch, "Junto.app");
    try {
      const paths: string[] = [];
      for (const target of ["darwin-arm64", "linux-x64"] as const) {
        const bundle = path.join(app, "Contents/Resources/machines", target);
        await mkdir(path.join(bundle, "bin"), { recursive: true });
        await mkdir(path.join(bundle, "core"));
        for (const file of ["bin/node", "bin/junto", "core/junto.cjs"]) {
          const absolute = path.join(bundle, file);
          await writeFile(absolute, target === "darwin-arm64" && file.startsWith("bin/") ? Buffer.from("cffaedfe01020304", "hex") : "payload");
          await chmod(absolute, file.startsWith("bin/") ? 0o755 : 0o644);
          paths.push(absolute);
        }
        const calls: string[][] = [];
        await signMachineBundle(bundle, target, environment, (_program: string, args: string[]) => {
          calls.push(args);
          if (args.includes("--sign")) appendFileSync(args.at(-1)!, "signed");
        });
        expect(calls.filter(args => args.includes("--sign"))).toHaveLength(target === "darwin-arm64" ? 2 : 0);
        for (const args of calls.filter(args => args.includes("--sign"))) {
          expect(args).toContain("runtime");
          expect(args).toContain(environment.JUNTO_MAC_SIGNING_IDENTITY);
          expect(args.find(value => value.endsWith(".plist"))).toContain("entitlements.machine-runtime.plist");
        }
        await writeFile(path.join(bundle, "manifest.json"), JSON.stringify({ build: "a".repeat(64), target, node: "26.10.0", appVersion: "0.7.0", files: await machineBundleFiles(bundle) }));
      }
      const before = await snapshotMachinePayloads(app);
      vi.stubEnv("JUNTO_MAC_TEAM_ID", environment.JUNTO_MAC_TEAM_ID);
      vi.stubEnv("JUNTO_MAC_SIGNING_IDENTITY", environment.JUNTO_MAC_SIGNING_IDENTITY);
      signAsync.mockImplementation(async options => {
        // osx-sign uses instanceof Array in its own realm, while the builder
        // imports the custom hook through another realm.
        const signingRealmArray = runInNewContext("Array");
        const ignores = options.ignore instanceof signingRealmArray ? options.ignore : [options.ignore];
        for (const file of paths) {
          const ignored = ignores.some((entry: unknown) => typeof entry === "function" ? entry(file) : Boolean(file.match(String(entry))));
          expect(ignored).toBe(true);
          if (!ignored) appendFileSync(file, "second signature");
          expect(() => options.optionsForFile(file)).toThrow(/re-sign/);
        }
      });
      await signJuntoApp({ app, platform: "darwin", ignore: () => false });
      assertMachinePayloadsUnchanged(before, await snapshotMachinePayloads(app));
      await expect(auditMachinePayloads(app)).resolves.toBeUndefined();
      await writeFile(paths[0]!, "changed by a second sign");
      expect(() => assertMachinePayloadsUnchanged(before, [...before.slice(1)])).toThrow(/bin\/junto/);
      await expect(auditMachinePayloads(app)).rejects.toThrow(/files do not match/);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });

  it("leaves unsigned builds alone and refuses partial signing configuration", async () => {
    await expect(signMachineBundle("missing", "darwin-arm64", {})).resolves.toBeUndefined();
    await expect(signMachineBundle("missing", "linux-x64", environment)).resolves.toBeUndefined();
    await expect(signMachineBundle("missing", "darwin-arm64", { JUNTO_MAC_TEAM_ID: environment.JUNTO_MAC_TEAM_ID })).rejects.toThrow(/SIGNING_IDENTITY/);
  });
});
