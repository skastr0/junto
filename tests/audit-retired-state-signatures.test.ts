import {
  lstat,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import {
  RETIRED_PRODUCT_STATE_COMPOUND_SIGNATURES,
  RETIRED_PRODUCT_STATE_SIGNATURES,
  RetiredStateSignatureAuditError,
  auditRetiredStateAsar,
  auditRetiredStateBuffer,
  auditRetiredStateFile,
} from "../scripts/audit-retired-state-signatures";

const tempRoots: string[] = [];

const makeTempRoot = async (): Promise<string> => {
  const root = await mkdtemp(
    join(tmpdir(), "vellum-retired-signature-audit-"),
  );
  tempRoots.push(root);
  return root;
};

const makeAsar = async (
  files: Readonly<Record<string, string | Uint8Array>>,
): Promise<string> => {
  const root = await makeTempRoot();
  const source = join(root, "source");
  const archive = join(root, "app.asar");
  for (const [relative, contents] of Object.entries(files)) {
    const destination = join(source, relative);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, contents);
  }
  await createPackage(source, archive);
  expect((await lstat(archive)).isFile()).toBe(true);
  return archive;
};

afterEach(async () => {
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("retired product-state signature boundary", () => {
  it.each(RETIRED_PRODUCT_STATE_SIGNATURES)(
    "rejects the exact retired signature %s",
    (signature) => {
      expect(() =>
        auditRetiredStateBuffer(
          Buffer.from(`runtime-prefix\0${signature}\0runtime-suffix`),
          { label: "dist/vellum" },
        )
      ).toThrowError(
        expect.objectContaining({
          name: "RetiredStateSignatureAuditError",
          code: "retired-signature",
          message: expect.stringContaining(signature),
        }),
      );
    },
  );

  it("allows the current SQLite authority vocabulary", () => {
    const current = Buffer.from(
      [
        "~/.vellum/state/vellum.db",
        "state_schema_identity",
        "canvas_generations",
        "work_events",
        "station_projection",
        "settings_preferences",
      ].join("\0"),
    );
    expect(
      auditRetiredStateBuffer(current, { label: "dist/vellum-station" }),
    ).toEqual({
      label: "dist/vellum-station",
      scannedBytes: current.byteLength,
    });
  });

  it.each(RETIRED_PRODUCT_STATE_COMPOUND_SIGNATURES)(
    "rejects the retired compound signature $label",
    ({ label, signatures }) => {
      expect(() =>
        auditRetiredStateBuffer(
          Buffer.from(signatures.join("\0current-runtime\0")),
          { label: "app.asar:out/main/index.js" },
        )
      ).toThrowError(
        expect.objectContaining({
          code: "retired-signature",
          message: expect.stringContaining(label),
        }),
      );
      for (const signature of signatures) {
        expect(() =>
          auditRetiredStateBuffer(Buffer.from(signature), {
            label: "one current runtime token",
          })
        ).not.toThrow();
      }
    },
  );

  it("bounds executable buffers and regular-file reads before accepting them", async () => {
    const root = await makeTempRoot();
    const executable = join(root, "vellum-browser");
    await writeFile(executable, "state_schema_identity");

    await expect(
      auditRetiredStateFile(executable, {
        label: "vellum-browser",
        maxBytes: 21,
      }),
    ).resolves.toEqual({
      label: "vellum-browser",
      scannedBytes: 21,
    });
    await expect(
      auditRetiredStateFile(executable, {
        label: "vellum-browser",
        maxBytes: 20,
      }),
    ).rejects.toMatchObject({ code: "byte-bound" });

    const linked = join(root, "linked-vellum-browser");
    await symlink(executable, linked);
    await expect(auditRetiredStateFile(linked)).rejects.toMatchObject({
      code: "not-regular-file",
    });
  });
});

describe("first-party ASAR retired-state audit", () => {
  it("scans out and station text while ignoring third-party signatures", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "state_schema_identity",
      "out/renderer/index.html": "<main>vellum.db</main>",
      "station/plugin.json": '{"name":"vellum"}',
      "node_modules/legacy/index.js": "settings.json",
      "package.json": '{"legacy":"hosts.json"}',
      "out/renderer/model.glb": Buffer.from("current.json"),
    });

    const receipt = auditRetiredStateAsar(archive);
    expect(receipt).toMatchObject({
      archivePath: archive,
      scannedEntries: 3,
      scannedRoots: ["out", "station"],
    });
    expect(receipt.archiveEntries).toBeGreaterThan(receipt.scannedEntries);
    expect(receipt.scannedBytes).toBeGreaterThan(0);
  });

  it("rejects a retired signature extracted from a first-party entry", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "const authority = 'canvas-authority-v1'",
      "station/plugin.json": '{"name":"vellum"}',
    });
    expect(() => auditRetiredStateAsar(archive)).toThrowError(
      expect.objectContaining({
        code: "retired-signature",
        message: expect.stringContaining("app.asar:out/main/index.js"),
      }),
    );
  });

  it("requires both first-party roots to have a scannable runtime", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "state_schema_identity",
      "station/model.glb": Buffer.from("binary"),
    });
    expect(() => auditRetiredStateAsar(archive)).toThrowError(
      expect.objectContaining({
        code: "root-bound",
        message: expect.stringContaining("station/"),
      }),
    );
  });

  it("fails closed at archive, first-party, per-entry, and total byte bounds", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "123456",
      "out/preload/index.cjs": "abcdef",
      "station/plugin.json": "123456",
      "node_modules/effect/index.js": "third-party",
    });
    const cases = [
      { maxAsarEntries: 1 },
      { maxFirstPartyTextEntries: 2 },
      { maxAsarEntryBytes: 5 },
      { maxAsarTextBytes: 17 },
    ] as const;
    for (const limits of cases) {
      expect(() =>
        auditRetiredStateAsar(archive, { limits })
      ).toThrowError(
        expect.objectContaining({
          name: "RetiredStateSignatureAuditError",
          code: expect.stringMatching(/^(entry|byte)-bound$/u),
        }),
      );
    }
  });

  it("rejects non-positive and unsafe bounds", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "state_schema_identity",
      "station/plugin.json": '{"name":"vellum"}',
    });
    for (const maxAsarEntries of [
      0,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
    ]) {
      expect(() =>
        auditRetiredStateAsar(archive, {
          limits: { maxAsarEntries },
        })
      ).toThrowError(RetiredStateSignatureAuditError);
    }
  });
});
