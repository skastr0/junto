import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import {
  auditPackagedStateUpdatePreflight,
  PACKAGED_STATE_UPDATE_PREFLIGHT_MAIN_ENTRY,
  PACKAGED_STATE_UPDATE_PREFLIGHT_PROTOCOL,
  PACKAGED_STATE_UPDATE_PREFLIGHT_SWITCH,
} from "../scripts/audit-packaged-app";

const roots: string[] = [];

const makeAsar = async (main: string): Promise<string> => {
  const root = await mkdtemp(
    join(tmpdir(), "vellum-state-preflight-asar-"),
  );
  roots.push(root);
  const source = join(root, "source");
  const mainPath = join(
    source,
    ...PACKAGED_STATE_UPDATE_PREFLIGHT_MAIN_ENTRY.split("/"),
  );
  await mkdir(dirname(mainPath), { recursive: true });
  await writeFile(mainPath, main);
  const archive = join(root, "app.asar");
  await createPackage(source, archive);
  return archive;
};

const validMain = [
  PACKAGED_STATE_UPDATE_PREFLIGHT_SWITCH,
  PACKAGED_STATE_UPDATE_PREFLIGHT_PROTOCOL,
  "[state-preflight] packaged candidate execution is required",
  "state-update-preflight-unpackaged",
  "state-update-preflight-complete",
  "state-update-preflight-failure",
].join("\n");

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("packaged state update preflight ASAR audit", () => {
  it("extracts and admits the one bounded packaged main entry", async () => {
    const archive = await makeAsar(validMain);
    expect(auditPackagedStateUpdatePreflight(archive)).toEqual({
      entry: PACKAGED_STATE_UPDATE_PREFLIGHT_MAIN_ENTRY,
      switch: PACKAGED_STATE_UPDATE_PREFLIGHT_SWITCH,
      protocol: PACKAGED_STATE_UPDATE_PREFLIGHT_PROTOCOL,
      packagedOnly: true,
      bytes: Buffer.byteLength(validMain),
    });
  });

  it("rejects a packaged main missing the unpackaged refusal proof", async () => {
    const archive = await makeAsar(
      validMain.replace(
        "[state-preflight] packaged candidate execution is required",
        "",
      ),
    );
    expect(() =>
      auditPackagedStateUpdatePreflight(archive),
    ).toThrow(/requires exactly one/u);
  });
});
