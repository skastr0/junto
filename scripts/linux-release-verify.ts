import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  readLinuxReleaseKeyringFile,
  verifyLinuxReleaseBundle,
  type LinuxReleaseHostFacts,
} from "./linux-release-bundle";
import type { StationProtocolSupport } from "../src/shared/station-protocol";

const MAX_OUTPUT_BYTES = 64 * 1024;

const parseOptions = (
  args: ReadonlyArray<string>,
): {
  readonly bundle: string;
  readonly peerStationProtocol: StationProtocolSupport;
  readonly keyring: string;
  readonly trustedKeyringRevision: number;
  readonly trustedKeyringSha256: string;
  readonly trustedKeyId: string;
  readonly trustedKeyFingerprintSha256: string;
  readonly installedVersion?: string;
} => {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (
      current !== "--bundle" &&
      current !== "--peer-station-protocol-preferred" &&
      current !== "--peer-station-protocol-compatible-from" &&
      current !== "--peer-station-protocol-warn-below" &&
      current !== "--keyring" &&
      current !== "--trusted-keyring-revision" &&
      current !== "--trusted-keyring-sha256" &&
      current !== "--trusted-key-id" &&
      current !== "--trusted-key-fingerprint-sha256" &&
      current !== "--installed-version"
    ) {
      throw new Error(`unknown verifier option: ${current ?? "<missing>"}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--") || values.has(current)) {
      throw new Error(`missing or duplicate verifier option: ${current}`);
    }
    values.set(current, value);
    index += 1;
  }
  const bundle = values.get("--bundle");
  const preferred = values.get("--peer-station-protocol-preferred");
  const compatibleFrom = values.get(
    "--peer-station-protocol-compatible-from",
  );
  const warnBelow = values.get("--peer-station-protocol-warn-below");
  const keyring = values.get("--keyring");
  const keyringRevision = values.get("--trusted-keyring-revision");
  const keyringSha256 = values.get("--trusted-keyring-sha256");
  const trustedKeyId = values.get("--trusted-key-id");
  const trustedKeyFingerprintSha256 = values.get(
    "--trusted-key-fingerprint-sha256",
  );
  if (
    bundle === undefined ||
    preferred === undefined ||
    !/^[1-9][0-9]*$/u.test(preferred) ||
    !Number.isSafeInteger(Number(preferred)) ||
    compatibleFrom === undefined ||
    !/^[1-9][0-9]*$/u.test(compatibleFrom) ||
    !Number.isSafeInteger(Number(compatibleFrom)) ||
    warnBelow === undefined ||
    !/^[1-9][0-9]*$/u.test(warnBelow) ||
    !Number.isSafeInteger(Number(warnBelow)) ||
    keyring === undefined ||
    keyringRevision === undefined ||
    !/^[1-9][0-9]*$/u.test(keyringRevision) ||
    keyringSha256 === undefined ||
    !/^[0-9a-f]{64}$/u.test(keyringSha256) ||
    trustedKeyId === undefined ||
    trustedKeyFingerprintSha256 === undefined
  ) {
    throw new Error(
      "usage: junto-linux-verify-x64 --bundle DIR --keyring FILE --trusted-keyring-revision N --trusted-keyring-sha256 HEX --trusted-key-id ID --trusted-key-fingerprint-sha256 HEX --peer-station-protocol-preferred N --peer-station-protocol-compatible-from N --peer-station-protocol-warn-below N [--installed-version X.Y.Z]",
    );
  }
  return {
    bundle,
    peerStationProtocol: {
      preferred: Number(preferred),
      compatibleFrom: Number(compatibleFrom),
      warnBelow: Number(warnBelow),
    },
    keyring,
    trustedKeyringRevision: Number(keyringRevision),
    trustedKeyringSha256: keyringSha256,
    trustedKeyId,
    trustedKeyFingerprintSha256,
    ...(values.get("--installed-version") === undefined
      ? {}
      : { installedVersion: values.get("--installed-version") }),
  };
};

const runFixed = (
  executable: string,
  args: ReadonlyArray<string>,
  label: string,
): string => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    env: {
      PATH: "/usr/sbin:/usr/bin:/sbin:/bin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  });
  if (
    result.error !== undefined ||
    result.status !== 0 ||
    Buffer.byteLength(result.stdout ?? "", "utf8") > MAX_OUTPUT_BYTES
  ) {
    throw new Error(`could not inspect ${label}`);
  }
  return (result.stdout ?? "").trim();
};

const parseOsRelease = (
  input: string,
): { readonly distribution: string; readonly version: string } => {
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z_]+)=(?:"([^"]*)"|([^#\s]*))$/u);
    if (match !== null) fields.set(match[1], match[2] ?? match[3]);
  }
  const distribution = fields.get("ID");
  const version = fields.get("VERSION_ID");
  if (distribution === undefined || version === undefined) {
    throw new Error("could not inspect Linux distribution");
  }
  return { distribution, version };
};

export const inspectLinuxReleaseHost = async (): Promise<
  LinuxReleaseHostFacts
> => {
  const os = parseOsRelease(await readFile("/etc/os-release", "utf8"));
  const libc = runFixed(
    "/usr/bin/getconf",
    ["GNU_LIBC_VERSION"],
    "glibc version",
  ).match(/^([a-z]+)\s+([0-9]+\.[0-9]+)$/u);
  if (libc === null) throw new Error("could not inspect glibc version");
  return {
    platform: process.platform,
    architecture: process.arch,
    machine: runFixed("/usr/bin/uname", ["-m"], "machine architecture"),
    distribution: os.distribution,
    distributionVersion: os.version,
    libcFamily: libc[1],
    libcVersion: libc[2],
  };
};

export const linuxReleaseVerifyMain = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  const options = parseOptions(args);
  const bundleDirectory = path.resolve(options.bundle);
  const [host, trustedKeyring] = await Promise.all([
    inspectLinuxReleaseHost(),
    readLinuxReleaseKeyringFile(options.keyring),
  ]);
  const receipt = await verifyLinuxReleaseBundle({
    bundleDirectory,
    host,
    peerStationProtocol: options.peerStationProtocol,
    trustedKeyring,
    trustedKeyringRevision: options.trustedKeyringRevision,
    trustedKeyringSha256: options.trustedKeyringSha256,
    trustedKeyId: options.trustedKeyId,
    trustedKeyFingerprintSha256: options.trustedKeyFingerprintSha256,
    ...(options.installedVersion === undefined
      ? {}
      : { installedVersion: options.installedVersion }),
  });
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
};

if (import.meta.main) {
  linuxReleaseVerifyMain(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Linux release verification failed: ${message}\n`);
    process.exitCode = 1;
  });
}
