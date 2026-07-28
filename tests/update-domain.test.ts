import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitsRemoteAutoRollout,
  bindPreflightReceipt,
  canAuthorizeInstall,
  hashFileSha256,
  isMintedCandidate,
  mintAuthorizedCandidate,
  remoteRolloutTargetVersion,
} from "../src/main/vellum/update/domain";
import type { StateUpdatePreflightReceipt } from "../src/main/vellum/state/candidate-readiness";
import { STATE_UPDATE_PREFLIGHT_PROTOCOL } from "../src/main/vellum/state/candidate-readiness";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const fakeReceipt = (
  candidateId: string,
): StateUpdatePreflightReceipt =>
  ({
    protocol: STATE_UPDATE_PREFLIGHT_PROTOCOL,
    candidateId,
    source: "fresh",
    sourceSchemaVersion: 0,
    targetSchemaVersion: 3,
    targetSchemaSha256: "a".repeat(64),
    installationId: "01JTESTINSTALLATION00000000",
    role: "command-center",
    canvasCount: 0,
    actorSeatCount: 0,
    workSnapshotCount: 0,
    pendingCommandCount: 0,
    armedRegionCount: 0,
    schedulerCursorCount: 0,
    ready: true,
  }) as StateUpdatePreflightReceipt;

describe("update domain", () => {
  it("mints authority that structurally similar objects cannot claim", () => {
    const minted = mintAuthorizedCandidate({
      version: "0.2.0",
      downloadedFile: "/tmp/update.zip",
      zipSha256: "b".repeat(64),
    });
    expect(isMintedCandidate(minted)).toBe(true);
    expect(
      isMintedCandidate({
        ...minted,
      }),
    ).toBe(false);
    expect(canAuthorizeInstall(minted)).toBe(false);
  });

  it("binds preflight receipt only for the exact ZIP digest", () => {
    const minted = mintAuthorizedCandidate({
      version: "0.2.0",
      downloadedFile: "/tmp/update.zip",
      zipSha256: "c".repeat(64),
    });
    const bound = bindPreflightReceipt(
      minted,
      fakeReceipt("11111111-1111-4111-8111-111111111111"),
      "c".repeat(64),
    );
    expect(canAuthorizeInstall(bound)).toBe(true);
    expect(() =>
      bindPreflightReceipt(
        minted,
        fakeReceipt("11111111-1111-4111-8111-111111111111"),
        "d".repeat(64),
      ),
    ).toThrow(/zip digest/u);
  });

  it("hashes file contents as sha256", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-update-hash-"));
    roots.push(root);
    const path = join(root, "payload.bin");
    const body = Buffer.from("vellum-update-fixture");
    await writeFile(path, body);
    const expected = createHash("sha256").update(body).digest("hex");
    const digest = await Effect.runPromise(hashFileSha256(path));
    expect(digest).toBe(expected);
  });

  it("remote auto-rollout targets only the running CC version", () => {
    expect(remoteRolloutTargetVersion("0.1.0")).toBe("0.1.0");
    expect(
      admitsRemoteAutoRollout({
        commandCenterVersion: "0.1.0",
        targetVersion: "0.1.0",
      }),
    ).toBe(true);
    expect(
      admitsRemoteAutoRollout({
        commandCenterVersion: "0.1.0",
        targetVersion: "0.2.0",
      }),
    ).toBe(false);
  });
});
