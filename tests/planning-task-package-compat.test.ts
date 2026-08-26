import { createHash } from "node:crypto";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { Result } from "effect";
import { beforeAll, describe, expect, it } from "vitest";
import {
  renderSchemaContract,
  tasksCreateSchema,
} from "../src/cli/core/discovery";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";
import { STATION_CONTROL_PROTOCOL } from "../src/shared/station-api-envelope";
import { STATION_API_PROTOCOL } from "../src/shared/station-api";
import {
  CURRENT_STATION_PROTOCOL_SUPPORT,
  STATION_PROTOCOL_BASELINE,
  selectStationProtocolCodec,
} from "../src/shared/station-protocol";
import { STATION_SESSION_PROTOCOL } from "../src/shared/station-session";
import {
  WORK_PROTOCOL,
  decodeWorkRecord,
} from "../src/shared/work-protocol";

const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/planning-task-package-compat/", import.meta.url),
);
const PROJECT_ROOT = resolve(FIXTURE_ROOT, "../../..");
const QUALIFIER = join(FIXTURE_ROOT, "qualify.mjs");
const MANIFEST_SHA256 =
  "6793ede7c5d4724394470ad88745d5928fc47223893d1d34694983d096dee47d";

const sha256 = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");
const readJson = <A>(path: string): A =>
  JSON.parse(readFileSync(path, "utf8")) as A;

type DecodeOutcome = {
  readonly accepted: boolean;
  readonly namesAdmission?: boolean;
  readonly namesRaisedBy?: boolean;
};

type Matrix = {
  readonly cohort: {
    readonly tasksCreateSchemaId: string;
    readonly stateSchemaVersion: number;
    readonly stationProtocolBaseline: number;
    readonly stationProtocolSupport: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
    readonly workProtocol: string;
  };
  readonly records: Readonly<Record<string, DecodeOutcome>>;
  readonly negotiation: { readonly _tag: string };
  readonly guarded: {
    readonly versionedDecoderInvocations: number;
    readonly result: { readonly accepted: boolean; readonly reason?: string };
    readonly rejection?: {
      readonly reason: string;
      readonly retryable: boolean;
    };
  };
};

type Qualification = {
  readonly integrity: { readonly verifiedFiles: number };
  readonly matrices: {
    readonly released: Matrix;
    readonly legacyV2: Matrix;
    readonly current: Matrix;
    readonly currentAgainstReleased: Matrix;
  };
  readonly releasedPackageInstrument: {
    readonly baseline: number;
    readonly support: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
    readonly protocol1Negotiation: { readonly _tag: string };
    readonly records: Readonly<
      Record<string, { readonly outcome: "accepted" | "rejected"; readonly error?: string }>
    >;
  };
  readonly schema18Refusal: {
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly byteIdentical: boolean;
    readonly beforeSidecars: ReadonlyArray<string>;
    readonly afterSidecars: ReadonlyArray<string>;
    readonly userVersion: number;
    readonly sentinel: { readonly id: string; readonly payload: string };
    readonly probe: {
      readonly compatibility: {
        readonly ok: boolean;
        readonly reason: string;
        readonly userVersion: number;
        readonly supportedVersion: number;
      };
    };
  };
};

type Manifest = {
  readonly contract: string;
  readonly v3Introduction: {
    readonly commit: string;
    readonly parent: string;
  };
  readonly cohorts: Readonly<
    Record<
      string,
      {
        readonly commit: string;
        readonly treeOidSha1: string;
        readonly archive: { readonly bytes: number; readonly sha256: string };
        readonly cohort: {
          readonly releaseStatus: string;
          readonly remoteArtifactStatus: string;
          readonly appVersion: string;
          readonly stateSchemaVersion: number;
          readonly tasksCreateSchemaId: string;
          readonly stationProtocolBaseline: number;
        };
        readonly sourceBlobs: ReadonlyArray<{
          readonly path: string;
          readonly gitBlobOidSha1: string;
          readonly sha256: string;
        }>;
        readonly bundle: {
          readonly artifactKind: string;
          readonly isReleasedPackage: boolean;
        };
      }
    >
  >;
  readonly publicPackage: {
    readonly receipt: string;
    readonly instrumentedDecoder: {
      readonly artifactKind: string;
      readonly isReleasedPackage: boolean;
    };
  };
  readonly protocolPins: {
    readonly preTaskBaseCommit: string;
    readonly taskCreateCanonicalJsonSha256: string;
    readonly unchangedFiles: ReadonlyArray<{
      readonly path: string;
      readonly gitBlobOidSha1: string;
      readonly sha256: string;
      readonly bytes: number;
    }>;
  };
  readonly honestFindings: ReadonlyArray<string>;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
};

type PublicPackageReceipt = {
  readonly releaseAuthority: {
    readonly kind: string;
    readonly feedSha256: string;
    readonly githubReleaseAbsent: boolean;
  };
  readonly zip: {
    readonly bytes: number;
    readonly sha256: string;
    readonly sha512Base64: string;
  };
  readonly extractedApp: {
    readonly productName: string;
    readonly bundleShortVersion: string;
    readonly codesignDeepStrict: string;
    readonly staplerValidation: string;
    readonly gatekeeperAssessment: string;
    readonly appAsarSha256: string;
    readonly mainBundleSha256: string;
    readonly cliSha256: string;
  };
  readonly buildTreeProvenance: {
    readonly versionBumpCommit: string;
    readonly embeddedCommit: string | null;
    readonly exactBuildTreeProven: boolean;
    readonly packageIncludesAtLeastCommit: string;
    readonly indistinguishableTestsOnlyChild: string;
    readonly dirtyBuildExcluded: boolean;
  };
  readonly cohort: {
    readonly stateSchemaVersion: number;
    readonly tasksCreateSchemaId: string;
    readonly stationProtocolBaseline: number;
    readonly stationProtocolSupport: {
      readonly preferred: number;
      readonly compatibleFrom: number;
      readonly warnBelow: number;
    };
  };
  readonly actualPackageCommands: {
    readonly cliVersion: { readonly stdout: string; readonly note: string };
    readonly tasksCreateSchema: {
      readonly exitCode: number;
      readonly stdoutSha256: string;
      readonly data: {
        readonly schema_id: string;
        readonly description: string;
        readonly schema: {
          readonly properties: Readonly<Record<string, unknown>>;
          readonly additionalProperties: boolean;
        };
      };
    };
  };
  readonly actualPackageProtocol1Preface: {
    readonly response: {
      readonly frame: string;
      readonly stateSchemaVersion: number;
      readonly support: {
        readonly preferred: number;
        readonly compatibleFrom: number;
        readonly warnBelow: number;
      };
      readonly reason: string;
      readonly retryable: boolean;
    };
    readonly result: string;
    readonly productMapping: string;
  };
  readonly actualPackageSchema20Refusal: {
    readonly exitCode: number;
    readonly diagnostic: string;
    readonly before: { readonly sha256: string; readonly bytes: number; readonly mtime_ns: number };
    readonly after: { readonly sha256: string; readonly bytes: number; readonly mtime_ns: number };
    readonly byteIdentical: boolean;
    readonly userVersionAfter: number;
    readonly sentinelAfter: string;
  };
  readonly compiledDecoderEvidence: {
    readonly label: string;
  };
  readonly limitation: string;
};

type Samples = {
  readonly records: Readonly<Record<string, unknown>>;
};

const manifest = readJson<Manifest>(join(FIXTURE_ROOT, "package-pair.json"));
const publicPackage = readJson<PublicPackageReceipt>(
  join(FIXTURE_ROOT, "public-package-receipt.json"),
);
const samples = readJson<Samples>(join(FIXTURE_ROOT, "decoder-samples.json"));
let qualification: Qualification;

beforeAll(() => {
  const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
  delete env.FORCE_COLOR;
  const child = spawnSync("node", [QUALIFIER], {
    cwd: PROJECT_ROOT,
    env,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  expect(child.status, child.stderr || child.stdout).toBe(0);
  qualification = JSON.parse(child.stdout) as Qualification;
}, 60_000);

describe("planning Task package provenance", () => {
  it("pins every executable fixture and detects tampering", () => {
    expect(
      sha256(readFileSync(join(FIXTURE_ROOT, "package-pair.json"))),
    ).toBe(MANIFEST_SHA256);
    expect(manifest.contract).toBe(
      "vellum-command/planning-task-package-provenance/v2",
    );
    expect(qualification.integrity.verifiedFiles).toBe(manifest.files.length);

    const parent = mkdtempSync(join(tmpdir(), "vellum-command-package-tamper-"));
    const copy = join(parent, "fixture");
    try {
      cpSync(FIXTURE_ROOT, copy, { recursive: true });
      const target = join(
        copy,
        "bundles/unreleased-protocol1-v2-decoder.mjs.gz",
      );
      const bytes = readFileSync(target);
      const index = Math.floor(bytes.length / 2);
      bytes[index] = bytes[index]! ^ 0x01;
      writeFileSync(target, bytes);
      const tampered = spawnSync(
        "node",
        [join(copy, "qualify.mjs"), "--root", copy, "--integrity-only"],
        { encoding: "utf8" },
      );
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toMatch(/fixture hash mismatch/u);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });

  it("separates the released Command Center package from both unreleased source cohorts", () => {
    expect(manifest.cohorts["released-0.1.14"]?.cohort).toMatchObject({
      releaseStatus: "released-command-center-macos",
      remoteArtifactStatus: "no-released-remote-artifact",
      appVersion: "0.1.14",
      stateSchemaVersion: 18,
      tasksCreateSchemaId: "tasks.create.input/v2",
      stationProtocolBaseline: 5,
    });
    expect(manifest.cohorts["unreleased-protocol1-v2"]?.cohort).toMatchObject({
      releaseStatus: "unreleased-source-cohort",
      remoteArtifactStatus: "remote-stations-not-released",
      tasksCreateSchemaId: "tasks.create.input/v2",
      stationProtocolBaseline: 1,
    });
    expect(manifest.cohorts["current-v3"]?.cohort).toMatchObject({
      releaseStatus: "unreleased-candidate-source-cohort",
      remoteArtifactStatus: "remote-stations-not-released",
      tasksCreateSchemaId: "tasks.create.input/v3",
      stationProtocolBaseline: 1,
    });
    for (const cohort of Object.values(manifest.cohorts)) {
      expect(cohort.bundle).toMatchObject({
        artifactKind: "archive-built-source-decoder-bundle",
        isReleasedPackage: false,
      });
    }
    expect(manifest.publicPackage.instrumentedDecoder).toMatchObject({
      artifactKind: "instrumented-released-package-decoder-bundle",
      isReleasedPackage: false,
    });
    expect(publicPackage.compiledDecoderEvidence.label).toContain(
      "not an unmodified signed package",
    );
    expect(publicPackage.limitation).toContain(
      "No older Remote package has been released",
    );
  });

  it("records the public 0.1.14 asset and its non-exact build-tree provenance", () => {
    expect(publicPackage.releaseAuthority).toMatchObject({
      kind: "cloudflare-r2-generic-feed",
      feedSha256:
        "c6f8a2f0e5bba9de4621a067ea2ab3ff1e9820d6e40c013363e8b91f8b38e734",
      githubReleaseAbsent: true,
    });
    expect(publicPackage.zip).toMatchObject({
      bytes: 176_039_073,
      sha256:
        "e47a0edb0eb1642b517a7916855dae1f911d4c6006bfe9e31c356b3621a6670e",
      sha512Base64:
        "vACmL001sTgBRCe45SNkxDtflhyuuhi+30bWGDwn51vXpz5ELDbv3lnOEKkFgmKLObjAvvdmYermcM9dsZQYvQ==",
    });
    expect(publicPackage.extractedApp).toMatchObject({
      productName: "Vellum Command",
      bundleShortVersion: "0.1.14",
      codesignDeepStrict: "passed",
      staplerValidation: "passed",
      gatekeeperAssessment: "accepted-notarized-developer-id",
      appAsarSha256:
        "11ccaee77152f1e9024c1ac24048370173a058f840c0bd9b6cd25332e5953bbf",
      mainBundleSha256:
        "9564bbabfc5ce075951e70d1a80520ba58454adb27384d6b67bd2594af01ee66",
      cliSha256:
        "17609d6a0a61b9fa36ed9fdff3d72c0b6649a8b6501d0848587e6cdaa05179d5",
    });
    expect(publicPackage.buildTreeProvenance).toEqual({
      ...publicPackage.buildTreeProvenance,
      versionBumpCommit: "1719b8d04576fe85332f4a1bbc8eb0d8814c470c",
      embeddedCommit: null,
      exactBuildTreeProven: false,
      packageIncludesAtLeastCommit:
        "2dc82e9e8d9a20e99dba5d3c147b590c74332a24",
      indistinguishableTestsOnlyChild:
        "87960b970a3a32bdc6dfb25e8055869d0c887313",
      dirtyBuildExcluded: false,
    });

    const packageSchema = publicPackage.actualPackageCommands.tasksCreateSchema;
    expect(packageSchema).toMatchObject({
      exitCode: 0,
      stdoutSha256:
        "9a784865b0057263bcf57c53b3e4f7aed3b60e8cf528aba55bac83daa63a6ca6",
      data: {
        schema_id: "tasks.create.input/v2",
        schema: { additionalProperties: false },
      },
    });
    expect(packageSchema.data.description).toContain(
      "approval mints a submitted Task",
    );
    expect(packageSchema.data.schema.properties).toHaveProperty("dependsOn");
    expect(publicPackage.actualPackageCommands.cliVersion.stdout).toBe(
      "vellum-command v0.1.0\n",
    );
    expect(publicPackage.actualPackageCommands.cliVersion.note).toContain(
      "not app provenance",
    );
  });

  it("proves the released package has no protocol-1 overlap or partial Work decode", () => {
    expect(publicPackage.cohort).toMatchObject({
      stateSchemaVersion: 18,
      tasksCreateSchemaId: "tasks.create.input/v2",
      stationProtocolBaseline: 5,
      stationProtocolSupport: {
        preferred: 5,
        compatibleFrom: 5,
        warnBelow: 5,
      },
    });
    expect(publicPackage.actualPackageProtocol1Preface.response).toMatchObject({
      frame: "reject",
      stateSchemaVersion: 18,
      support: { preferred: 5, compatibleFrom: 5, warnBelow: 5 },
      reason: "no-common-version",
      retryable: false,
    });
    expect(publicPackage.actualPackageProtocol1Preface.result).toContain(
      "before session or Work decoding",
    );
    expect(publicPackage.actualPackageProtocol1Preface.productMapping).toContain(
      "update-required",
    );

    expect(qualification.matrices.released.negotiation._tag).toBe("no-common");
    expect(
      qualification.matrices.released.guarded.versionedDecoderInvocations,
    ).toBe(0);
    expect(qualification.matrices.released.guarded.rejection).toMatchObject({
      reason: "no-common-version",
      retryable: false,
    });
    expect(qualification.matrices.currentAgainstReleased.negotiation._tag).toBe(
      "no-common",
    );
    expect(
      qualification.matrices.currentAgainstReleased.guarded
        .versionedDecoderInvocations,
    ).toBe(0);

    expect(qualification.releasedPackageInstrument).toMatchObject({
      baseline: 5,
      support: { preferred: 5, compatibleFrom: 5, warnBelow: 5 },
      protocol1Negotiation: { _tag: "no-common" },
    });
    expect(qualification.releasedPackageInstrument.records.legacy?.outcome).toBe(
      "accepted",
    );
    expect(
      qualification.releasedPackageInstrument.records.dependsOnOnly?.outcome,
    ).toBe("accepted");
    expect(
      qualification.releasedPackageInstrument.records.admissionOnly,
    ).toMatchObject({ outcome: "rejected" });
    expect(
      qualification.releasedPackageInstrument.records.admissionOnly?.error,
    ).toMatch(/admission/u);
    expect(
      qualification.releasedPackageInstrument.records.raisedByOnly?.error,
    ).toMatch(/raisedBy/u);
    expect(
      qualification.releasedPackageInstrument.records.currentV3?.outcome,
    ).toBe("rejected");
  });

  it("executes the exact unreleased protocol-1 v2 decoder instead of a re-authored Schema", () => {
    const legacy = manifest.cohorts["unreleased-protocol1-v2"];
    expect(legacy).toMatchObject({
      commit: "57571f60ba1d2033ec27dc536a151f60c8fc8e87",
      treeOidSha1: "7e62be161016a7165184a899c617e3da8f5ba661",
      archive: {
        bytes: 95_160_320,
        sha256:
          "95c5c94159543a346861c2250fb9e64b948d268aedd691b84cd926cccd0f6ee6",
      },
    });
    expect(
      legacy?.sourceBlobs.find((blob) => blob.path === "src/shared/work-model.ts"),
    ).toMatchObject({
      gitBlobOidSha1: "c30c7269ca5db7bc1441639091d843d96b3b832b",
      sha256:
        "94e9cc8b429e595b495d5d25e1cf25113bf9223a84b2380f3841c0a07c26cbf1",
    });
    expect(
      legacy?.sourceBlobs.find(
        (blob) => blob.path === "src/shared/work-protocol.ts",
      ),
    ).toMatchObject({
      gitBlobOidSha1: "d29bbf5ffacab135241487ef7de1ac6b2c520e5b",
      sha256:
        "11ff732148a27aed5d23701c67aa36fbd0c4045c8701d52d9056e5b0aa20ac7b",
    });
    expect(manifest.v3Introduction).toMatchObject({
      commit: "e846e7d11d2ed4d0a0d1bcf6a58ccf243ad514e7",
      parent: "57571f60ba1d2033ec27dc536a151f60c8fc8e87",
    });

    const matrix = qualification.matrices.legacyV2;
    expect(matrix.cohort).toMatchObject({
      tasksCreateSchemaId: "tasks.create.input/v2",
      stateSchemaVersion: 20,
      stationProtocolBaseline: 1,
      stationProtocolSupport: {
        preferred: 1,
        compatibleFrom: 1,
        warnBelow: 1,
      },
      workProtocol: "vellum/work/v2",
    });
    expect(matrix.negotiation._tag).toBe("selected");
    expect(matrix.guarded.versionedDecoderInvocations).toBe(1);
    expect(matrix.guarded.result.accepted).toBe(false);
    expect(matrix.records.legacy?.accepted).toBe(true);
    expect(matrix.records.dependsOnOnly?.accepted).toBe(true);
    expect(matrix.records.admissionOnly).toMatchObject({
      accepted: false,
      namesAdmission: true,
    });
    expect(matrix.records.raisedByOnly).toMatchObject({
      accepted: false,
      namesRaisedBy: true,
    });
    expect(matrix.records.currentV3?.accepted).toBe(false);

    expect(manifest.honestFindings.join("\n")).toContain(
      "already accepts dependsOn",
    );
  });

  it("executes the exact current v3 archive and accepts the current Task shape", () => {
    const current = manifest.cohorts["current-v3"];
    expect(current).toMatchObject({
      commit: "e020eb03bd2caf895796f240dc88909983894c8d",
      treeOidSha1: "76835a52d5372338c788845555ba1fd4751d16b6",
      archive: {
        bytes: 101_806_080,
        sha256:
          "0e0a6a89b4939e269150fb8a0771e3a5b3ecf553a7d6a269189ebac30c5a50e9",
      },
    });
    expect(
      current?.sourceBlobs.find((blob) => blob.path === "src/shared/work-model.ts"),
    ).toMatchObject({
      gitBlobOidSha1: "11548753f68a0ceca2b28c65f81fce873a889654",
      sha256:
        "1e4a3335b23da2575dc16c25ac63bf2b995f57b59369f5a13f6376a40ed2722a",
    });

    const matrix = qualification.matrices.current;
    expect(matrix.cohort).toMatchObject({
      tasksCreateSchemaId: "tasks.create.input/v3",
      stateSchemaVersion: 20,
      stationProtocolBaseline: 1,
      workProtocol: "vellum/work/v2",
    });
    expect(matrix.negotiation._tag).toBe("selected");
    expect(matrix.guarded.versionedDecoderInvocations).toBe(1);
    expect(matrix.guarded.result.accepted).toBe(true);
    expect(Object.values(matrix.records).every((outcome) => outcome.accepted)).toBe(
      true,
    );

    const liveSchema = renderSchemaContract(tasksCreateSchema);
    expect(liveSchema.schema_id).toBe("tasks.create.input/v3");
    expect(liveSchema.schema).toMatchObject({
      properties: {
        admission: {
          type: "string",
          enum: ["auto", "operator-gated", "operator-owned"],
        },
        dependsOn: { type: "array" },
      },
      additionalProperties: false,
    });
    const liveCurrent = decodeWorkRecord(samples.records.currentV3);
    expect(Result.isSuccess(liveCurrent)).toBe(true);
  });

  it("proves schema-18 refusal before product mutation and pins unchanged protocol bytes", () => {
    expect(qualification.schema18Refusal).toMatchObject({
      byteIdentical: true,
      beforeSidecars: [],
      afterSidecars: [],
      userVersion: 20,
      sentinel: { id: "sentinel", payload: "must-survive" },
      probe: {
        compatibility: {
          ok: false,
          reason: "newer-than-supported",
          userVersion: 20,
          supportedVersion: 18,
        },
      },
    });
    expect(qualification.schema18Refusal.beforeSha256).toBe(
      qualification.schema18Refusal.afterSha256,
    );
    expect(publicPackage.actualPackageSchema20Refusal).toMatchObject({
      exitCode: 1,
      diagnostic: "schema user_version=20 supported=18 appVersion=0.1.14",
      byteIdentical: true,
      userVersionAfter: 20,
      sentinelAfter: "unchanged",
    });
    expect(publicPackage.actualPackageSchema20Refusal.before).toEqual(
      publicPackage.actualPackageSchema20Refusal.after,
    );

    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(20);
    expect(STATION_PROTOCOL_BASELINE).toBe(1);
    expect(CURRENT_STATION_PROTOCOL_SUPPORT).toEqual({
      preferred: 1,
      compatibleFrom: 1,
      warnBelow: 1,
    });
    expect(selectStationProtocolCodec(1)).toEqual(Result.succeed(1));
    expect(selectStationProtocolCodec(5)).toEqual(
      Result.fail("unsupported-station-protocol"),
    );
    expect({
      session: STATION_SESSION_PROTOCOL,
      api: STATION_API_PROTOCOL,
      control: STATION_CONTROL_PROTOCOL,
      work: WORK_PROTOCOL,
    }).toEqual({
      session: "vellum-command/station-session/v1",
      api: "vellum-command/station-api/v1",
      control: "vellum-command/station-control/v1",
      work: "vellum/work/v2",
    });

    expect(manifest.protocolPins.preTaskBaseCommit).toBe(
      "259d29a0518dd1b00d191f3b05b3a0b48adbe8d8",
    );
    for (const pin of manifest.protocolPins.unchangedFiles) {
      const bytes = readFileSync(join(PROJECT_ROOT, pin.path));
      expect(bytes.byteLength, pin.path).toBe(pin.bytes);
      expect(sha256(bytes), pin.path).toBe(pin.sha256);
    }
    const stationCorpus = readJson<{
      readonly taskCreateFact: unknown;
    }>(join(PROJECT_ROOT, "tests/fixtures/station-protocol-v1/content-wire-corpus.json"));
    expect(sha256(JSON.stringify(stationCorpus.taskCreateFact))).toBe(
      manifest.protocolPins.taskCreateCanonicalJsonSha256,
    );
  });
});
