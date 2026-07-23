import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  admitLinuxRemoteArtifact,
  buildLinuxRemoteDeployScript,
  decodeLinuxRemoteReceipt,
} from "../src/main/vellum/hosts/deploy-linux";

const receipt = (scope: "release" | "evidence", file: string, body: string) => ({
  scope, file, bytes: Buffer.byteLength(body), sha256: createHash("sha256").update(body).digest("hex"),
});

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-linux-admit-"));
  const release = join(root, "release"); const evidence = join(root, "evidence");
  await Promise.all([mkdir(release), mkdir(evidence)]);
  const deb = "Vellum Command-1.2.3-x64-linux.deb"; const debBody = "deb-bytes";
  await writeFile(join(release, deb), debBody);
  const diagnostic = "Vellum Command-1.2.3-x64-linux.unpacked.tar.gz";
  const required = ["inventory.json", "package-audit.json", "packaged-pty-smoke.json", "packaged-runtime-smoke.json", "test-receipt.json"];
  await mkdir(join(evidence, "logs"));
  await writeFile(join(evidence, diagnostic), "diagnostic");
  await writeFile(join(evidence, "logs", "qualification.log"), "passed\n");
  await Promise.all(required.map((file) => writeFile(join(evidence, file), `{\"${file}\":true}\n`)));
  const evidenceEntries = await Promise.all(required.map(async (file) => {
    const body = `{\"${file}\":true}\n`; return receipt("evidence", file, body);
  }));
  return {
    root,
    release,
    evidence,
    manifest: {
      schema: "vellum/linux-release-evidence/v1",
      target: { os: "linux", architecture: "x64", machine: "x86_64", distribution: "ubuntu", distributionVersion: "24.04", libc: "glibc" },
      source: { commit: "a".repeat(40), sourceDateEpoch: 1_784_700_000 },
      publishable: { format: "deb", file: deb },
      diagnostic: { format: "tar.gz", file: diagnostic },
      evidence: [
        receipt("release", deb, debBody),
        receipt("evidence", diagnostic, "diagnostic"),
        ...evidenceEntries,
        receipt("evidence", "logs/qualification.log", "passed\n"),
      ],
      unsupported: ["linux-arm64", "musl", "appimage", "snap", "flatpak", "rpm"],
    },
  };
};

describe("Linux Remote deployment program", () => {
  it("accepts only one bounded readiness receipt", () => {
    expect(decodeLinuxRemoteReceipt("LINUX_REMOTE_READY version=1.2.3\n")).toBe("1.2.3");
    expect(decodeLinuxRemoteReceipt("LINUX_REMOTE_READY version=1\nextra\n")).toBeUndefined();
    expect(decodeLinuxRemoteReceipt("LINUX_REMOTE_READY version=$(id)\n")).toBeUndefined();
  });

  it("uses a private unique stage and fixed package commands", () => {
    const script = buildLinuxRemoteDeployScript();
    expect(script).toContain('umask 077');
    expect(script).toContain('mktemp -d "$BASE/incoming.XXXXXX"');
    expect(script).toContain('trap cleanup EXIT HUP INT TERM');
    expect(script).toContain('dpkg-deb --info "$DEB"');
    expect(script).not.toMatch(/sudo|apt-get|curl|wget|systemctl|loginctl|pkill|killall|--no-sandbox/u);
  });

  it("admits only the exact CI deb plus audited readiness receipts", async () => {
    const input = await fixture();
    try {
      await expect(admitLinuxRemoteArtifact({ manifest: input.manifest, releaseDirectory: input.release, evidenceDirectory: input.evidence })).resolves.toMatchObject({ version: "1.2.3", bytes: 9 });
      await expect(admitLinuxRemoteArtifact({ manifest: { ...input.manifest, target: { ...input.manifest.target, libc: "musl" } }, releaseDirectory: input.release, evidenceDirectory: input.evidence })).rejects.toThrow(/Ubuntu 24.04/u);
      await expect(admitLinuxRemoteArtifact({ manifest: { ...input.manifest, publishable: { format: "deb", file: "other.deb" } }, releaseDirectory: input.release, evidenceDirectory: input.evidence })).rejects.toThrow(/invalid deb identity/u);
      await expect(admitLinuxRemoteArtifact({ manifest: { ...input.manifest, evidence: input.manifest.evidence.filter((entry) => entry.file !== "test-receipt.json") }, releaseDirectory: input.release, evidenceDirectory: input.evidence })).rejects.toThrow(/required evidence/u);
      await expect(admitLinuxRemoteArtifact({ manifest: { ...input.manifest, evidence: [...input.manifest.evidence, receipt("release", "Vellum Command-9-x64-linux.deb", "other")] }, releaseDirectory: input.release, evidenceDirectory: input.evidence })).rejects.toThrow(/single bounded/u);
      await expect(admitLinuxRemoteArtifact({ manifest: { ...input.manifest, evidence: [...input.manifest.evidence, input.manifest.evidence[0]] }, releaseDirectory: input.release, evidenceDirectory: input.evidence })).rejects.toThrow(/single bounded|duplicates/u);
      await rm(join(input.evidence, "package-audit.json"));
      await symlink(join(input.evidence, "inventory.json"), join(input.evidence, "package-audit.json"));
      await expect(admitLinuxRemoteArtifact({ manifest: input.manifest, releaseDirectory: input.release, evidenceDirectory: input.evidence })).rejects.toThrow(/does not match/u);
    } finally { await rm(input.root, { recursive: true, force: true }); }
  });
});
