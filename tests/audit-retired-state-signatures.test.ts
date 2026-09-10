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
  auditLinuxRetiredStateRuntimeBundle,
  auditRetiredStateRuntimeBundle,
  LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES,
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
          { label: "dist/vellum-command" },
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
        "~/.vellum-command/state/vellum-command.db",
        "state_schema_identity",
        "canvas_generations",
        "work_events",
        "station_projection_versions",
        "station_projection_head",
        "settings_preferences",
      ].join("\0"),
    );
    expect(
      auditRetiredStateBuffer(current, { label: "dist/vellum-command-station" }),
    ).toEqual({
      label: "dist/vellum-command-station",
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
    const executable = join(root, "vellum-command-browser");
    await writeFile(executable, "state_schema_identity");

    await expect(
      auditRetiredStateFile(executable, {
        label: "vellum-command-browser",
        maxBytes: 21,
      }),
    ).resolves.toEqual({
      label: "vellum-command-browser",
      scannedBytes: 21,
    });
    await expect(
      auditRetiredStateFile(executable, {
        label: "vellum-command-browser",
        maxBytes: 20,
      }),
    ).rejects.toMatchObject({ code: "byte-bound" });

    const linked = join(root, "linked-vellum-command-browser");
    await symlink(executable, linked);
    await expect(auditRetiredStateFile(linked)).rejects.toMatchObject({
      code: "not-regular-file",
    });
  });
});

describe("first-party ASAR retired-state audit", () => {
  it("scans compiled app text while ignoring third-party signatures", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "state_schema_identity",
      "out/renderer/index.html": "<main>vellum-command.db</main>",
      "out/runtime.json": '{"name":"vellum"}',
      "node_modules/legacy/index.js": "settings.json",
      "package.json": '{"legacy":"hosts.json"}',
      "out/renderer/model.glb": Buffer.from("current.json"),
    });

    const receipt = auditRetiredStateAsar(archive);
    expect(receipt).toMatchObject({
      archivePath: archive,
      scannedEntries: 3,
      scannedRoots: ["out"],
    });
    expect(receipt.archiveEntries).toBeGreaterThan(receipt.scannedEntries);
    expect(receipt.scannedBytes).toBeGreaterThan(0);
  });

  it("rejects a retired signature extracted from a first-party entry", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "const authority = 'canvas-authority-v1'",
      "out/runtime.json": '{"name":"vellum"}',
    });
    expect(() => auditRetiredStateAsar(archive)).toThrowError(
      expect.objectContaining({
        code: "retired-signature",
        message: expect.stringContaining("app.asar:out/main/index.js"),
      }),
    );
  });

  it("requires the compiled app root to have a scannable runtime", async () => {
    const archive = await makeAsar({
      "out/model.glb": Buffer.from("binary"),
    });
    expect(() => auditRetiredStateAsar(archive)).toThrowError(
      expect.objectContaining({
        code: "root-bound",
        message: expect.stringContaining("out/"),
      }),
    );
  });

  it("rejects the retired private station template even beside valid app code", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "state_schema_identity",
      "station/plugin.json": '{"name":"retired-template"}',
    });
    expect(() => auditRetiredStateAsar(archive)).toThrowError(
      expect.objectContaining({ code: "invalid-entry", message: expect.stringContaining("retired station/") }),
    );
  });

  it("fails closed at archive, first-party, per-entry, and total byte bounds", async () => {
    const archive = await makeAsar({
      "out/main/index.js": "123456",
      "out/preload/index.cjs": "abcdef",
      "out/runtime.json": "123456",
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
      "out/runtime.json": '{"name":"vellum"}',
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

describe("complete packaged runtime retired-state audit", () => {
  it.each(["asar", "work"] as const)(
    "rejects a retired signature in the %s target",
    async (target) => {
      const root = await makeTempRoot();
      const archive = await makeAsar({
        "out/main/index.js":
          target === "asar" ? "incoming.frame" : "state_schema_identity",
        "out/runtime.json": '{"name":"vellum"}',
      });
      const work = join(root, "vellum");
      await writeFile(
        work,
        target === "work" ? "incoming.frame" : "state_schema_identity",
      );
      await expect(
        auditRetiredStateRuntimeBundle({
          asarPath: archive,
          workCliPath: work,
        }),
      ).rejects.toMatchObject({
        code: "retired-signature",
      });
    },
  );
});

describe("complete Linux packaged runtime retired-state audit", () => {
  it.each(["asar", "work", "installer", "bridge"] as const)(
    "rejects a retired signature in the %s target",
    async (target) => {
      const root = await makeTempRoot();
      const archive = await makeAsar({
        "out/main/index.js": target === "asar" ? "incoming.frame" : "safe",
        "out/runtime.json": '{"name":"vellum"}',
      });
      const paths = Object.fromEntries(await Promise.all(
        ["work", "installer", "bridge"].map(async (name) => {
          const file = join(root, `vellum-${name}`);
          await writeFile(file, name === target ? "incoming.frame" : "safe");
          return [name, file];
        }),
      )) as Record<"work" | "installer" | "bridge", string>;
      await expect(auditLinuxRetiredStateRuntimeBundle({
        asarPath: archive,
        workCliPath: paths.work,
        installerPath: paths.installer,
        bridgePath: paths.bridge,
      })).rejects.toMatchObject({ code: "retired-signature" });
    },
  );

  it("keeps every Linux executable scan finite", async () => {
    const root = await makeTempRoot();
    const helper = join(root, "vellum-release-installer");
    await writeFile(helper, "safe");
    expect(auditRetiredStateBuffer(new Uint8Array(
      LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES,
    ), { maxBytes: LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES })).toMatchObject({
      scannedBytes: LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES,
    });
    expect(() => auditRetiredStateBuffer(new Uint8Array(
      LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES + 1,
    ), { maxBytes: LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES })).toThrow(/scan bound/u);
    expect(LINUX_RELEASE_HELPER_RETIRED_STATE_AUDIT_MAX_BYTES).toBe(112 * 1024 * 1024);
  });
});
