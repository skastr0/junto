import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectStateUpdateCandidate,
  STATE_UPDATE_PREFLIGHT_PROTOCOL,
} from "../src/main/vellum/state/candidate-readiness";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";
import { withStateUpdateCandidate } from "../src/main/vellum/state/update-candidate";

const candidateSource = vi.hoisted(() => ({ path: "" }));
vi.mock("../src/main/vellum/state/engine", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/main/vellum/state/engine")
  >()),
  stateDatabasePath: () => candidateSource.path,
}));

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const fixturePath = (file: string): string =>
  decodeURIComponent(
    new URL(`./fixtures/state-v1/${file}`, import.meta.url).pathname,
  );

const fileSha256 = async (path: string): Promise<string> => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const cases = [
  {
    role: "command-center",
    file: "command-center-v1.db",
    fixtureSha256:
      "e1c12bcf3a662f52854936bfee1c0ef5fd41e024e80d7223bd3c90e0a1d00d2c",
  },
  {
    role: "remote",
    file: "remote-v1.db",
    fixtureSha256:
      "23db672fe4f4fbc7fbe0fe4a5c9efd3f009f93f4500462aa036b9aa57ac19cc9",
  },
] as const;

describe("frozen v1 candidate preflight", () => {
  it.each(cases)(
    "proves the representative $role store without mutating it",
    async ({ role, file, fixtureSha256 }) => {
      const source = fixturePath(file);
      expect(await fileSha256(source)).toBe(fixtureSha256);

      const root = await mkdtemp(
        join(tmpdir(), `vellum-${role}-candidate-`),
      );
      roots.push(root);
      const stateDirectory = join(root, "state");
      const installed = join(stateDirectory, "vellum.db");
      await mkdir(stateDirectory);
      await copyFile(source, installed);
      const before = await fileSha256(installed);
      candidateSource.path = installed;

      const receipt = await Effect.runPromise(
        withStateUpdateCandidate(
          inspectStateUpdateCandidate,
        ),
      );

      expect(receipt).toMatchObject({
        protocol: STATE_UPDATE_PREFLIGHT_PROTOCOL,
        source: "installed",
        sourceSchemaVersion: 1,
        targetSchemaVersion: CURRENT_STATE_SCHEMA_VERSION,
        role,
        canvasCount: 1,
        ready: true,
      });
      expect(receipt.installationId.length).toBeGreaterThan(0);
      expect(receipt.backupFile).toMatch(
        /^vellum-backup-[0-9a-f-]{36}\.db$/u,
      );
      expect(receipt.activeIntent).toBeDefined();

      expect(await fileSha256(installed)).toBe(before);
      expect(await fileSha256(source)).toBe(fixtureSha256);
      expect(
        existsSync(join(stateDirectory, "update-candidates")),
      ).toBe(true);
      expect(
        await readdir(join(stateDirectory, "update-candidates")),
      ).toEqual([]);
      expect(await readdir(join(stateDirectory, "backups"))).toEqual([
        receipt.backupFile,
      ]);
    },
  );
});
