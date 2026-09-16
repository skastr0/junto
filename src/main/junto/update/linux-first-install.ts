import { verifyLinuxDesktopReleaseFiles } from "../../../shared/linux-desktop-release-files";
import { loadEmbeddedLinuxDesktopReleaseTrust } from "../../../shared/linux-desktop-release-crypto";
import {
  stageLinuxDesktopRelease,
  revalidateLinuxDesktopRelease,
  activateLinuxDesktopRelease,
  assertLinuxDesktopFirstInstallAvailable,
  LinuxDesktopActivationError,
} from "./linux-install";
import { assertCurrentLinuxDesktopTarget } from "./linux-target";

export const LINUX_DESKTOP_BOOTSTRAP_VERSION = "1.0.0";
export const LINUX_DESKTOP_BOOTSTRAP_COMMAND = "linux-desktop-bootstrap";

export interface LinuxDesktopFirstInstallInput {
  readonly release: string;
  readonly archive: string;
  readonly home?: string;
}

export interface LinuxDesktopBootstrapIdentity {
  readonly bootstrap_version: string;
  readonly keyring_revision: number;
  readonly trusted_keyring_sha256: string;
  readonly trusted_key_id: string;
  readonly trusted_key_fingerprint_sha256: string;
}

export interface LinuxDesktopFirstInstallResult extends LinuxDesktopBootstrapIdentity {
  readonly version: string;
  readonly archive_sha256: string;
  readonly executable_path: string;
  readonly launched: false;
  readonly next_step: string;
}

export const linuxDesktopBootstrapIdentity = (): LinuxDesktopBootstrapIdentity => {
  const trust = loadEmbeddedLinuxDesktopReleaseTrust();
  return {
    bootstrap_version: LINUX_DESKTOP_BOOTSTRAP_VERSION,
    keyring_revision: trust.keyring.revision,
    trusted_keyring_sha256: trust.policy.trustedKeyringSha256,
    trusted_key_id: trust.policy.trustedKeyId,
    trusted_key_fingerprint_sha256: trust.policy.trustedKeyFingerprintSha256,
  };
};

export const installLinuxDesktop = async (
  input: LinuxDesktopFirstInstallInput,
  options: { readonly assertTarget?: () => Promise<void> } = {},
): Promise<LinuxDesktopFirstInstallResult> => {
  await (options.assertTarget ?? assertCurrentLinuxDesktopTarget)();
  const home = input.home === undefined ? {} : { home: input.home };
  await assertLinuxDesktopFirstInstallAvailable(home);
  const descriptor = await verifyLinuxDesktopReleaseFiles({
    releasePath: input.release,
    archivePath: input.archive,
  });
  const staged = await stageLinuxDesktopRelease({
    archivePath: input.archive,
    descriptor,
    ...home,
  });
  await revalidateLinuxDesktopRelease(staged);
  await activateLinuxDesktopRelease(staged, { mode: "first-install" });
  return {
    ...linuxDesktopBootstrapIdentity(),
    version: descriptor.version,
    archive_sha256: staged.archiveSha256,
    executable_path: staged.executablePath,
    launched: false,
    next_step:
      "Close any running Junto app, then open ~/.local/bin/junto-desktop. Future updates are installed from the app.",
  };
};

export type LinuxDesktopBootstrapArgs =
  | { readonly kind: "help" }
  | { readonly kind: "version" }
  | { readonly kind: "install"; readonly release: string; readonly archive: string };

const HELP = `Junto Linux desktop bootstrap ${LINUX_DESKTOP_BOOTSTRAP_VERSION}

Authenticate signed first-install inputs with this independently obtained
program. Do not extract or execute the candidate archive.

Usage:
  junto-desktop-bootstrap-linux-x64 --release FILE --archive FILE
  bun scripts/install-linux-desktop.ts --release FILE --archive FILE

Options:
  --release FILE   Downloaded signed release.json
  --archive FILE   Downloaded Linux x64 runtime archive
  --version        Print embedded bootstrap and release-trust identity
  --help           Show this help
`;

export const parseLinuxDesktopBootstrapArgs = (
  args: ReadonlyArray<string>,
): LinuxDesktopBootstrapArgs => {
  if (args.length === 1 && args[0] === "--help") return { kind: "help" };
  if (args.length === 1 && args[0] === "--version") return { kind: "version" };
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (
      current !== "--release" &&
      current !== "--archive"
    ) {
      throw new Error(`unknown bootstrap option: ${current ?? "<missing>"}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(current)) {
      throw new Error(`missing or duplicate bootstrap option: ${current}`);
    }
    values.set(current, value);
    index += 1;
  }
  const release = values.get("--release");
  const archive = values.get("--archive");
  if (release === undefined || archive === undefined) {
    throw new Error(
      "usage: --release FILE --archive FILE",
    );
  }
  return { kind: "install", release, archive };
};

const writeJson = (stream: NodeJS.WriteStream, value: unknown): void => {
  stream.write(`${JSON.stringify(value)}\n`);
};

export const runLinuxDesktopBootstrap = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  try {
    const parsed = parseLinuxDesktopBootstrapArgs(args);
    if (parsed.kind === "help") {
      process.stdout.write(HELP);
      return;
    }
    if (parsed.kind === "version") {
      writeJson(process.stdout, {
        ok: true,
        command: LINUX_DESKTOP_BOOTSTRAP_COMMAND,
        data: linuxDesktopBootstrapIdentity(),
      });
      return;
    }
    const data = await installLinuxDesktop(parsed);
    writeJson(process.stdout, {
      ok: true,
      command: LINUX_DESKTOP_BOOTSTRAP_COMMAND,
      data,
    });
  } catch (cause) {
    process.exitCode = 1;
    const activated = cause instanceof LinuxDesktopActivationError
      ? cause.activated
      : undefined;
    const next_step = activated === true
      ? "The Linux desktop launcher was already published before this failure; first install is complete on disk. Do not re-run the bootstrap or replace the launcher. Open ~/.local/bin/junto-desktop when ready; future updates come from the app."
      : "Obtain the independently authenticated bootstrap or a reviewed source checkout. Check the signed release inputs and supported host. An existing managed installation must update through the app.";
    writeJson(process.stderr, {
      ok: false,
      command: LINUX_DESKTOP_BOOTSTRAP_COMMAND,
      error: {
        type: "LinuxDesktopInstallError",
        message: cause instanceof Error ? cause.message : String(cause),
        details: {
          next_step,
          ...(activated === undefined ? {} : { activated }),
        },
      },
    });
  }
};
