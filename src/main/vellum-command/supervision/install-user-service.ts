/**
 * Sealed owner-home install of the Linux Remote user service + unified CLI.
 *
 * Derives the immutable release root from this binary's absolute path only —
 * no caller-supplied paths. Writes only:
 *   ~/.config/systemd/user/vellum-command-remote.service
 *   ~/.local/bin/vellum-command
 */
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  renderUserlandLinuxService,
  USERLAND_LINUX_SERVICE_PATH,
} from "./systemd-user";

export const INSTALL_USER_SERVICE_SWITCH = "--install-user-service" as const;

/** Shell wrapper path (preferred product argv0 under a release). */
const RELEASE_WRAPPER_MARKER = "/resources/bin/vellum-command-remote" as const;
/** Bundled Node entry (wrapper execs node on this path). */
const RELEASE_ENTRY_MARKER = "/resources/app-remote/vellum-command-remote.js" as const;
const CLI_RELATIVE = "resources/bin/vellum-command" as const;
const CLI_HELPER_RELATIVE = ".local/bin/vellum-command" as const;

/** Active immutable generation: ~/.junto/runtime/releases/<semver>-<sha64>. */
const RELEASE_DIRECTORY =
  /^\/(?:[^/\u0000-\u001f\u007f]+\/)*\.junto\/runtime\/releases\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9a-f]{64}$/u;

/**
 * Candidate tree under userland runtime (releases or staging extract).
 * Staging holds `vellum-command-runtime-<semver>-linux-x64` before activation.
 */
const CANDIDATE_RUNTIME_ROOT =
  /^\/(?:[^/\u0000-\u001f\u007f]+\/)*\.junto\/runtime\/(?:releases\/(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-[0-9a-f]{64}|staging\/[^/\u0000-\u001f\u007f]+\/vellum-command-runtime-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-linux-x64)$/u;

const isOwnedNonLinkFile = (path: string, executable = false): boolean => {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    if (process.getuid !== undefined && info.uid !== process.getuid()) {
      return false;
    }
    if (executable && (info.mode & 0o111) === 0) return false;
    return true;
  } catch {
    return false;
  }
};

const isOwnedNonLinkDir = (path: string): boolean => {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    if (process.getuid !== undefined && info.uid !== process.getuid()) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
};

const resolveRemoteBinaryRoot = (
  binaryPath: string,
  admit: (root: string) => boolean,
  label: string,
): string => {
  if (!binaryPath.startsWith("/")) {
    throw new Error("vellum-command-remote binary path must be absolute");
  }
  let real: string;
  try {
    real = realpathSync(binaryPath);
  } catch {
    throw new Error("vellum-command-remote binary path is not resolvable");
  }
  const isWrapper = real.endsWith(RELEASE_WRAPPER_MARKER);
  const isEntry = real.endsWith(RELEASE_ENTRY_MARKER);
  if (!isWrapper && !isEntry) {
    throw new Error(
      "vellum-command-remote is not at resources/bin/vellum-command-remote or resources/app-remote/vellum-command-remote.js under a release",
    );
  }
  // Wrapper must be executable; the JS entry is loaded by bundled Node (may be 0644).
  if (!isOwnedNonLinkFile(real, isWrapper)) {
    throw new Error(
      isWrapper
        ? "vellum-command-remote binary must be an owned non-symlink executable"
        : "vellum-command-remote entry must be an owned non-symlink file",
    );
  }
  const marker = isWrapper ? RELEASE_WRAPPER_MARKER : RELEASE_ENTRY_MARKER;
  const root = real.slice(0, -marker.length);
  if (!admit(root)) {
    throw new Error(`${label} is not under the owner-local userland runtime layout`);
  }
  if (!isOwnedNonLinkDir(root)) {
    throw new Error("runtime root must be an owned non-symlink directory");
  }
  return root;
};

/**
 * Resolve a candidate runtime root (releases generation or staging extract)
 * during remote install cutover.
 */
export const resolveCandidateRuntimeRootFromRemoteBinary = (
  binaryPath: string,
): string =>
  resolveRemoteBinaryRoot(
    binaryPath,
    (root) => CANDIDATE_RUNTIME_ROOT.test(root),
    "candidate runtime root",
  );

/**
 * Resolve the generation-pinned release root from the absolute path of this
 * `vellum-command-remote` binary. Rejects anything outside the immutable userland layout.
 */
export const resolveReleaseDirectoryFromRemoteBinary = (
  binaryPath: string,
): string =>
  resolveRemoteBinaryRoot(
    binaryPath,
    (root) => RELEASE_DIRECTORY.test(root),
    "release directory",
  );

const requireHome = (): string => {
  const home = process.env.HOME?.trim();
  if (home === undefined || home === "" || !home.startsWith("/")) {
    throw new Error("HOME must be an absolute path");
  }
  if (!isOwnedNonLinkDir(home)) {
    throw new Error("HOME must be an owned non-symlink directory");
  }
  return home;
};

const atomicWriteFile = (path: string, body: string, mode: number): void => {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!isOwnedNonLinkDir(directory)) {
    throw new Error(`install destination parent is not owner-controlled: ${directory}`);
  }
  const staging = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(staging, body, { encoding: "utf8", mode, flag: "wx" });
    renameSync(staging, path);
  } catch (error) {
    try {
      unlinkSync(staging);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
  chmodSync(path, mode);
  if (!isOwnedNonLinkFile(path)) {
    throw new Error(`install did not produce an owned regular file: ${path}`);
  }
};

const installOwnedHelper = (
  release: string,
  home: string,
  relativeSource: string,
  relativeDestination: string,
  label: string,
): void => {
  const source = join(release, relativeSource);
  if (!isOwnedNonLinkFile(source, true)) {
    throw new Error(`release ${label} helper is missing or not executable`);
  }
  const destination = join(home, relativeDestination);
  const directory = dirname(destination);
  mkdirSync(directory, { recursive: true, mode: 0o755 });
  if (!isOwnedNonLinkDir(directory)) {
    throw new Error("helper destination parent is not owner-controlled");
  }
  const staging = `${destination}.tmp-${process.pid}`;
  try {
    copyFileSync(source, staging);
    chmodSync(staging, 0o755);
    renameSync(staging, destination);
  } catch (error) {
    try {
      unlinkSync(staging);
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
  if (!isOwnedNonLinkFile(destination, true)) {
    throw new Error(`${label} helper install did not produce an owned executable`);
  }
};

const installUnifiedCli = (release: string, home: string): void => {
  installOwnedHelper(release, home, CLI_RELATIVE, CLI_HELPER_RELATIVE, "vellum-command");
};

const enableUserService = (): void => {
  const reload = spawnSync(
    "/usr/bin/systemctl",
    ["--user", "daemon-reload"],
    { encoding: "utf8", shell: false },
  );
  if (reload.status !== 0) {
    throw new Error(
      `systemctl --user daemon-reload failed: ${reload.stderr.trim() || reload.stdout.trim() || "unknown"}`,
    );
  }
  const enable = spawnSync(
    "/usr/bin/systemctl",
    ["--user", "enable", "vellum-command-remote.service"],
    { encoding: "utf8", shell: false },
  );
  if (enable.status !== 0) {
    throw new Error(
      `systemctl --user enable failed: ${enable.stderr.trim() || enable.stdout.trim() || "unknown"}`,
    );
  }
};

/**
 * Sealed install: write the generation-pinned unit and owner-local station helper.
 * `binaryPath` must be the absolute path of this process's vellum-command-remote binary.
 */
export const installUserlandLinuxRemoteService = (
  binaryPath: string = process.execPath,
): {
  readonly releaseDirectory: string;
  readonly unitPath: string;
  readonly helperPath: string;
} => {
  const home = requireHome();
  const releaseDirectory = resolveReleaseDirectoryFromRemoteBinary(
    resolve(binaryPath),
  );
  const unitPath = join(home, USERLAND_LINUX_SERVICE_PATH);
  const unitBody = renderUserlandLinuxService({ releaseDirectory });
  atomicWriteFile(unitPath, unitBody, 0o600);
  installUnifiedCli(releaseDirectory, home);
  enableUserService();
  return Object.freeze({
    releaseDirectory,
    unitPath,
    helperPath: join(home, CLI_HELPER_RELATIVE),
  });
};
