import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  createLinuxQualificationCandidateManifest,
  createLinuxReleaseManifest,
  releasePublicKeyFingerprint,
  signLinuxQualificationCandidateMetadata,
  signLinuxReleaseMetadata,
} from "./linux-release-bundle";

const options = (
  args: ReadonlyArray<string>,
  allowed: ReadonlySet<string>,
): Map<string, string> => {
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !allowed.has(name) ||
      parsed.has(name) ||
      !name.startsWith("--")
    ) {
      throw new Error("invalid or duplicate Linux release tool option");
    }
    parsed.set(name, value);
  }
  return parsed;
};

const required = (input: Map<string, string>, name: string): string => {
  const value = input.get(name);
  if (value === undefined) throw new Error(`missing required option: ${name}`);
  return value;
};

const readPrivateKeyFromStdin = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    throw new Error("release private key must arrive on stdin, never argv");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("release private key is too large");
    chunks.push(buffer);
  }
  const privateKeyPem = Buffer.concat(chunks).toString("utf8");
  if (privateKeyPem.length === 0) throw new Error("release private key is empty");
  return privateKeyPem;
};

export const linuxReleaseToolMain = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  const [command, ...rest] = args;
  if (command === "create") {
    const parsed = options(
      rest,
      new Set([
        "--bundle",
        "--version",
        "--source-revision",
        "--created-at",
        "--expires-at",
        "--download-locator",
        "--key-id",
      ]),
    );
    const manifest = await createLinuxReleaseManifest({
      bundleDirectory: required(parsed, "--bundle"),
      version: required(parsed, "--version"),
      sourceRevision: required(parsed, "--source-revision"),
      createdAt: required(parsed, "--created-at"),
      expiresAt: required(parsed, "--expires-at"),
      downloadLocator: required(parsed, "--download-locator"),
      keyId: required(parsed, "--key-id"),
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        schema: manifest.schema,
        version: manifest.release.version,
        sourceRevision: manifest.source.revision,
        keyId: manifest.trust.keyId,
        signed: false,
        publishable: false,
      })}\n`,
    );
    return;
  }

  if (command === "create-qualification-candidate") {
    const parsed = options(
      rest,
      new Set([
        "--bundle",
        "--version",
        "--source-revision",
        "--created-at",
        "--expires-at",
        "--key-id",
      ]),
    );
    const manifest = await createLinuxQualificationCandidateManifest({
      bundleDirectory: required(parsed, "--bundle"),
      version: required(parsed, "--version"),
      sourceRevision: required(parsed, "--source-revision"),
      createdAt: required(parsed, "--created-at"),
      expiresAt: required(parsed, "--expires-at"),
      keyId: required(parsed, "--key-id"),
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        schema: manifest.schema,
        purpose: manifest.purpose,
        version: manifest.release.version,
        sourceRevision: manifest.source.revision,
        ciEvidenceSha256: manifest.source.ciEvidence.sha256,
        packageSha256: manifest.package.sha256,
        keyId: manifest.trust.keyId,
        signed: false,
        publishable: false,
      })}\n`,
    );
    return;
  }

  if (command === "sign") {
    const parsed = options(
      rest,
      new Set(["--bundle", "--key-id", "--signed-at"]),
    );
    const signature = await signLinuxReleaseMetadata({
      bundleDirectory: required(parsed, "--bundle"),
      keyId: required(parsed, "--key-id"),
      signedAt: required(parsed, "--signed-at"),
      privateKeyPem: await readPrivateKeyFromStdin(),
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        schema: signature.schema,
        keyId: signature.keyId,
        signedAt: signature.signedAt,
        publishable: false,
        next: "independent verification and human release authorization required",
      })}\n`,
    );
    return;
  }

  if (command === "sign-qualification-candidate") {
    const parsed = options(
      rest,
      new Set(["--bundle", "--key-id", "--signed-at"]),
    );
    const signature = await signLinuxQualificationCandidateMetadata({
      bundleDirectory: required(parsed, "--bundle"),
      keyId: required(parsed, "--key-id"),
      signedAt: required(parsed, "--signed-at"),
      privateKeyPem: await readPrivateKeyFromStdin(),
    });
    process.stdout.write(
      `${JSON.stringify({
        ok: true,
        schema: signature.schema,
        purpose: signature.purpose,
        keyId: signature.keyId,
        signedAt: signature.signedAt,
        publishable: false,
        next: "run Station qualification; this candidate cannot be published",
      })}\n`,
    );
    return;
  }

  if (command === "fingerprint") {
    const parsed = options(rest, new Set(["--public-key"]));
    const publicKeyPem = await readFile(
      required(parsed, "--public-key"),
      "utf8",
    );
    process.stdout.write(
      `${JSON.stringify({
        algorithm: "ed25519",
        fingerprintSha256: releasePublicKeyFingerprint(publicKeyPem),
      })}\n`,
    );
    return;
  }

  throw new Error(
    "usage: linux-release-tool.ts create|sign|create-qualification-candidate|sign-qualification-candidate|fingerprint [options]",
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  linuxReleaseToolMain(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Linux release tool failed: ${message}\n`);
    process.exitCode = 1;
  });
}
