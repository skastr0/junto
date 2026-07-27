import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  readLinuxReleaseKeyringFile,
  verifyLinuxReleaseBundle,
  type LinuxReleaseHostFacts,
  type LinuxReleasePackageIdentity,
} from "./linux-release-bundle";

const MAX_OUTPUT_BYTES = 64 * 1024;

const parseOptions = (
  args: ReadonlyArray<string>,
): {
  readonly bundle: string;
  readonly peerVersion: string;
  readonly peerStationApiProtocol: string;
  readonly peerWorkControlProtocol: string;
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
      current !== "--peer-version" &&
      current !== "--peer-station-api-protocol" &&
      current !== "--peer-work-control-protocol" &&
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
  const peerVersion = values.get("--peer-version");
  const stationApi = values.get("--peer-station-api-protocol");
  const workControl = values.get("--peer-work-control-protocol");
  const keyring = values.get("--keyring");
  const keyringRevision = values.get("--trusted-keyring-revision");
  const keyringSha256 = values.get("--trusted-keyring-sha256");
  const trustedKeyId = values.get("--trusted-key-id");
  const trustedKeyFingerprintSha256 = values.get(
    "--trusted-key-fingerprint-sha256",
  );
  if (
    bundle === undefined ||
    peerVersion === undefined ||
    stationApi === undefined ||
    stationApi.length === 0 ||
    workControl === undefined ||
    keyring === undefined ||
    keyringRevision === undefined ||
    !/^[1-9][0-9]*$/u.test(keyringRevision) ||
    keyringSha256 === undefined ||
    !/^[0-9a-f]{64}$/u.test(keyringSha256) ||
    trustedKeyId === undefined ||
    trustedKeyFingerprintSha256 === undefined
  ) {
    throw new Error(
      "usage: vellum-linux-verify-x64 --bundle DIR --keyring FILE --trusted-keyring-revision N --trusted-keyring-sha256 HEX --trusted-key-id ID --trusted-key-fingerprint-sha256 HEX --peer-version X.Y.Z --peer-station-api-protocol vellum/station-api/v1 --peer-work-control-protocol vellum-work/v1 [--installed-version X.Y.Z]",
    );
  }
  return {
    bundle,
    peerVersion,
    peerStationApiProtocol: stationApi,
    peerWorkControlProtocol: workControl,
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

const findDeb = async (bundleDirectory: string): Promise<string> => {
  const matches = (await readdir(bundleDirectory)).filter((name) =>
    /^Vellum Command-(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)-x64-linux\.deb$/u
      .test(name)
  );
  if (matches.length !== 1) {
    throw new Error("release bundle must contain one exact Vellum deb");
  }
  return path.join(bundleDirectory, matches[0]);
};

export const inspectLinuxDeb = async (
  bundleDirectory: string,
): Promise<LinuxReleasePackageIdentity> => {
  const deb = await findDeb(bundleDirectory);
  const fields = runFixed(
    "/usr/bin/dpkg-deb",
    ["--field", deb, "Package", "Version", "Architecture"],
    "deb metadata",
  ).split(/\r?\n/u);
  if (fields.length !== 3 || fields.some((value) => value.length === 0)) {
    throw new Error("deb metadata is incomplete");
  }
  return {
    packageName: fields[0],
    version: fields[1],
    architecture: fields[2],
  };
};

export const linuxReleaseVerifyMain = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  const options = parseOptions(args);
  const bundleDirectory = path.resolve(options.bundle);
  const [host, packageIdentity, trustedKeyring] = await Promise.all([
    inspectLinuxReleaseHost(),
    inspectLinuxDeb(bundleDirectory),
    readLinuxReleaseKeyringFile(options.keyring),
  ]);
  const receipt = await verifyLinuxReleaseBundle({
    bundleDirectory,
    host,
    packageIdentity,
    peerVersion: options.peerVersion,
    stationApiProtocol: options.peerStationApiProtocol,
    workControlProtocol: options.peerWorkControlProtocol,
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
