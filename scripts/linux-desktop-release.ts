#!/usr/bin/env bun
/** Local Linux desktop release preparation, signing, and verification. */
import { randomUUID } from "node:crypto";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LINUX_DESKTOP_TARGET,
  canonicalLinuxDesktopReleaseDescriptor,
  decodeLinuxDesktopReleaseDescriptor,
  linuxDesktopArchiveName,
  type LinuxDesktopReleaseDescriptor,
  type LinuxDesktopSignedRelease,
} from "../src/shared/linux-desktop-release";
import {
  decodeLinuxDesktopReleaseTrust,
  loadEmbeddedLinuxDesktopReleaseTrust,
  signLinuxDesktopRelease,
  verifyLinuxDesktopRelease,
  type LinuxDesktopReleaseTrust,
} from "../src/shared/linux-desktop-release-crypto";
import {
  readLinuxDesktopReleaseJson,
  verifyLinuxDesktopArchiveBinding,
  verifyLinuxDesktopReleaseFiles,
} from "../src/shared/linux-desktop-release-files";
const MAX_PRIVATE_KEY_BYTES = 64 * 1024;

export type LinuxDesktopReleaseCommand =
  | { readonly command: "help" }
  | {
      readonly command: "prepare";
      readonly archive: string;
      readonly version: string;
      readonly sourceRevision: string;
      readonly createdAt: string;
      readonly output: string;
    }
  | {
      readonly command: "sign";
      readonly descriptor: string;
      readonly output: string;
    }
  | {
      readonly command: "verify";
      readonly release: string;
      readonly currentVersion?: string;
      readonly requireNewer: boolean;
      readonly archive?: string;
      readonly now?: string;
    };

export const LINUX_DESKTOP_RELEASE_HELP = `Junto Linux desktop release tools

prepare --archive PATH --version X.Y.Z --source-revision SHA
        --created-at ISO --output PATH
sign    --descriptor PATH --output PATH < PRIVATE_KEY
verify  --release PATH [--current-version X.Y.Z] [--require-newer]
        [--archive PATH] [--now ISO]

Outputs are created exclusively. These commands never upload or publish.
The sign command reads a private key from stdin, limited to 65,536 bytes.
Use --help alone or after a command for this help.
`;

export const parseLinuxDesktopReleaseArgs = (
  argv: readonly string[],
): LinuxDesktopReleaseCommand => {
  if (
    (argv.length === 1 && argv[0] === "--help") ||
    (argv.length === 2 &&
      ["prepare", "sign", "verify"].includes(argv[0]!) &&
      argv[1] === "--help")
  ) return { command: "help" };
  const command = argv[0];
  if (command !== "prepare" && command !== "sign" && command !== "verify") {
    throw new Error("expected prepare, sign, or verify; use --help");
  }
  const allowed = new Set(command === "prepare"
    ? ["--archive", "--version", "--source-revision", "--created-at", "--output"]
    : command === "sign"
      ? ["--descriptor", "--output"]
      : ["--release", "--current-version", "--require-newer", "--archive", "--now"]);
  const flags = new Map<string, string>();
  for (let index = 1; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!allowed.has(flag) || flags.has(flag)) {
      throw new Error("unknown or duplicate command flag; use --help");
    }
    if (flag === "--require-newer") {
      flags.set(flag, "true");
      continue;
    }
    const value = argv[++index];
    if (value === undefined || value.trim() === "" || value.startsWith("--") || value.includes("\0")) {
      throw new Error("command flag requires a nonempty value; use --help");
    }
    flags.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = flags.get(flag);
    if (value === undefined) throw new Error(`missing required ${flag}`);
    return value;
  };
  if (command === "prepare") return {
    command,
    archive: required("--archive"),
    version: required("--version"),
    sourceRevision: required("--source-revision"),
    createdAt: required("--created-at"),
    output: required("--output"),
  };
  if (command === "sign") return {
    command,
    descriptor: required("--descriptor"),
    output: required("--output"),
  };
  if (flags.has("--require-newer") && !flags.has("--current-version")) {
    throw new Error("--require-newer requires --current-version");
  }
  return {
    command,
    release: required("--release"),
    requireNewer: flags.has("--require-newer"),
    ...(flags.has("--current-version") ? { currentVersion: flags.get("--current-version")! } : {}),
    ...(flags.has("--archive") ? { archive: flags.get("--archive")! } : {}),
    ...(flags.has("--now") ? { now: flags.get("--now")! } : {}),
  };
};

const writeExclusive = async (outputPath: string, contents: string): Promise<void> => {
  const destination = path.resolve(outputPath);
  const temporary = path.join(path.dirname(destination), `linux-desktop-release-stage-${randomUUID()}`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, destination);
  } finally {
    await unlink(temporary);
  }
};

export type LinuxDesktopReleaseCliOptions = {
  /** In-process test seam only. The CLI always uses embedded public trust. */
  readonly trust?: LinuxDesktopReleaseTrust;
  readonly now?: Date | string;
  readonly stdin?: AsyncIterable<Uint8Array | string>;
};

type PrepareInput = Omit<Extract<LinuxDesktopReleaseCommand, { command: "prepare" }>, "command">;
type SignInput = Omit<Extract<LinuxDesktopReleaseCommand, { command: "sign" }>, "command">;
type VerifyInput = Omit<Extract<LinuxDesktopReleaseCommand, { command: "verify" }>, "command">;

const readPrivateKeyStdin = async (source?: AsyncIterable<Uint8Array | string>): Promise<string> => {
  if (source === undefined && process.stdin.isTTY) throw new Error("sign requires private key bytes on stdin");
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const value of source ?? process.stdin) {
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > MAX_PRIVATE_KEY_BYTES) {
        chunk.fill(0);
        throw new Error("private key stdin exceeds its size limit");
      }
      chunks.push(chunk);
    }
    if (size === 0) throw new Error("private key stdin is empty");
    const bytes = Buffer.concat(chunks, size);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally {
      bytes.fill(0);
    }
  } catch (error) {
    if (error instanceof Error && ["private key stdin exceeds its size limit", "private key stdin is empty"].includes(error.message)) throw error;
    throw new Error("private key stdin could not be read as UTF-8");
  } finally {
    chunks.forEach((chunk) => chunk.fill(0));
  }
};

export const prepareLinuxDesktopRelease = async (
  input: PrepareInput,
  options: LinuxDesktopReleaseCliOptions = {},
): Promise<LinuxDesktopReleaseDescriptor> => {
  const trust = options.trust === undefined ? loadEmbeddedLinuxDesktopReleaseTrust() : decodeLinuxDesktopReleaseTrust(options.trust);
  const archive = await verifyLinuxDesktopArchiveBinding({
    archivePath: input.archive,
    version: input.version,
  });
  const descriptor = decodeLinuxDesktopReleaseDescriptor({
    schema: "junto/linux-desktop-release/v1",
    product: "Junto",
    channel: "alpha",
    version: input.version,
    sourceRevision: input.sourceRevision,
    createdAt: input.createdAt,
    target: LINUX_DESKTOP_TARGET,
    archive: {
      file: linuxDesktopArchiveName(input.version),
      path: `/linux/x64/${linuxDesktopArchiveName(input.version)}`,
      ...archive,
    },
    trust: {
      algorithm: "ed25519",
      keyId: trust.policy.trustedKeyId,
      keyringRevision: trust.policy.trustedKeyringRevision,
    },
  });
  await writeExclusive(input.output, canonicalLinuxDesktopReleaseDescriptor(descriptor));
  return descriptor;
};

export const signLinuxDesktopReleaseFile = async (
  input: SignInput,
  options: LinuxDesktopReleaseCliOptions = {},
): Promise<LinuxDesktopSignedRelease> => {
  const descriptor = decodeLinuxDesktopReleaseDescriptor(await readLinuxDesktopReleaseJson(input.descriptor));
  const trust = options.trust === undefined ? loadEmbeddedLinuxDesktopReleaseTrust() : decodeLinuxDesktopReleaseTrust(options.trust);
  const key = trust.keyring.keys.find((entry) => entry.keyId === trust.policy.trustedKeyId)!;
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (key.status !== "active" || key.revokedAt !== undefined || !Number.isFinite(now.getTime()) ||
      now.getTime() < Date.parse(key.validFrom) ||
      (key.signingEndsAt !== undefined && now.getTime() > Date.parse(key.signingEndsAt))) {
    throw new Error("release signing requires an active pinned key within its authorization window");
  }
  if (descriptor.trust.keyId !== key.keyId || descriptor.trust.keyringRevision !== trust.keyring.revision) {
    throw new Error("release descriptor does not match pinned signing trust");
  }
  const pem = await readPrivateKeyStdin(options.stdin);
  let envelope: LinuxDesktopSignedRelease;
  try {
    envelope = signLinuxDesktopRelease(descriptor, pem);
  } catch {
    throw new Error("private key could not sign this release descriptor");
  }
  verifyLinuxDesktopRelease(envelope, { trust, now });
  const canonicalEnvelope = {
    descriptor: JSON.parse(canonicalLinuxDesktopReleaseDescriptor(envelope.descriptor)) as unknown,
    signature: envelope.signature,
  };
  await writeExclusive(input.output, `${JSON.stringify(canonicalEnvelope)}\n`);
  return envelope;
};

export const verifyLinuxDesktopReleaseFile = async (
  input: VerifyInput,
  options: LinuxDesktopReleaseCliOptions = {},
): Promise<LinuxDesktopReleaseDescriptor> => {
  const now = input.now ?? options.now;
  const verification = {
    ...(options.trust === undefined ? {} : { trust: options.trust }),
    ...(now === undefined ? {} : { now }),
    ...(input.currentVersion === undefined ? {} : { currentVersion: input.currentVersion }),
    requireNewer: input.requireNewer,
  };
  return input.archive !== undefined
    ? verifyLinuxDesktopReleaseFiles({ ...verification, releasePath: input.release, archivePath: input.archive })
    : verifyLinuxDesktopRelease(await readLinuxDesktopReleaseJson(input.release), verification);
};

export const runLinuxDesktopRelease = async (
  argv: readonly string[],
  options: LinuxDesktopReleaseCliOptions = {},
): Promise<string> => {
  const input = parseLinuxDesktopReleaseArgs(argv);
  if (input.command === "help") return LINUX_DESKTOP_RELEASE_HELP;
  const descriptor = input.command === "prepare"
    ? await prepareLinuxDesktopRelease(input, options)
    : input.command === "sign"
      ? (await signLinuxDesktopReleaseFile(input, options)).descriptor
      : await verifyLinuxDesktopReleaseFile(input, options);
  return `${JSON.stringify({ ok: true, command: input.command, version: descriptor.version })}\n`;
};

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runLinuxDesktopRelease(process.argv.slice(2)).then(
    (output) => process.stdout.write(output),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : "unknown local release error";
      process.stderr.write(`${JSON.stringify({ ok: false, error: { type: "LinuxDesktopReleaseError", message: message.slice(0, 500) } })}\n`);
      process.exitCode = 1;
    },
  );
}
