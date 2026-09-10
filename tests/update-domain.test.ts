import { createHash } from "node:crypto";
import { mkdtemp, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  admitsRemoteAutoRollout,
  canAuthorizeInstall,
  canOperatorInstall,
  hashFileSha256,
  isMintedCandidate,
  mintAuthorizedCandidate,
  remoteRolloutTargetVersion,
} from "../src/main/vellum/update/domain";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

describe("update domain", () => {
  it("mints authority that structurally similar objects cannot claim", () => {
    const minted = mintAuthorizedCandidate({
      version: "0.2.0",
      downloadedFile: "/tmp/update.zip",
      archiveSha256: "b".repeat(64),
    });
    expect(isMintedCandidate(minted)).toBe(true);
    expect(
      isMintedCandidate({
        ...minted,
      }),
    ).toBe(false);
    expect(canAuthorizeInstall(minted)).toBe(false);
    expect(canOperatorInstall(minted)).toBe(false);
  });

  it("canOperatorInstall and canAuthorizeInstall require minted + stagedAppPath", () => {
    const withoutStage = mintAuthorizedCandidate({
      version: "0.2.0",
      downloadedFile: "/tmp/update.zip",
      archiveSha256: "c".repeat(64),
    });
    expect(canOperatorInstall(withoutStage)).toBe(false);
    expect(canAuthorizeInstall(withoutStage)).toBe(false);

    const withStage = mintAuthorizedCandidate({
      version: "0.2.0",
      downloadedFile: "/tmp/update.zip",
      archiveSha256: "c".repeat(64),
      stagedAppPath: "/tmp/Vellum Command.app/Contents/MacOS/Vellum Command",
    });
    expect(canOperatorInstall(withStage)).toBe(true);
    expect(canAuthorizeInstall(withStage)).toBe(true);
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

  it("refuses symlink and directory archive inputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "vellum-command-archive-admit-"));
    roots.push(root);
    const file = join(root, "archive.zip");
    const link = join(root, "redirect.zip");
    await writeFile(file, "real bytes");
    await symlink(file, link);
    await expect(Effect.runPromise(hashFileSha256(link))).rejects.toThrow();
    await expect(Effect.runPromise(hashFileSha256(root))).rejects.toThrow(/regular file/);
  });
});
