import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  linuxDebArtifactName,
  linuxUnpackedArtifactName,
} from "./finalize-linux-package";

export const LINUX_CI_TARGET = Object.freeze({
  runner: "ubuntu-24.04",
  os: "linux",
  architecture: "x64",
  machine: "x86_64",
  debArchitecture: "amd64",
  distribution: "ubuntu",
  distributionVersion: "24.04",
  libc: "glibc",
} as const);

export const LINUX_CI_REQUIRED_GATES = Object.freeze([
  "frozen-install",
  "target-inventory",
  "typecheck",
  "complete-unit-suite",
  "electron-and-cli-compile",
  "native-package",
  "package-audit",
  "deb-install",
  "packaged-pty-smoke",
  "packaged-runtime-smoke",
] as const);

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const packagePath = path.join(packageRoot, "package.json");

type LinuxCiGate = (typeof LINUX_CI_REQUIRED_GATES)[number];

export interface LinuxCiInventory {
  readonly schema: "vellum/linux-ci-inventory/v1";
  readonly target: typeof LINUX_CI_TARGET;
  readonly source: {
    readonly commit: string;
    readonly sourceDateEpoch: number;
  };
  readonly runtime: {
    readonly kernel: string;
    readonly machine: "x86_64";
    readonly glibc: string;
    readonly ubuntu: "24.04";
  };
  readonly tools: {
    readonly bun: string;
    readonly node: string;
    readonly electron: string;
    readonly nodePty: string;
    readonly electronBuilder: string;
    readonly dpkg: string;
    readonly dpkgDeb: string;
  };
}

export interface LinuxCiTestReceipt {
  readonly schema: "vellum/linux-ci-test-receipt/v1";
  readonly ok: true;
  readonly target: typeof LINUX_CI_TARGET;
  readonly gates: ReadonlyArray<{
    readonly name: LinuxCiGate;
    readonly status: "passed";
  }>;
}

export interface LinuxCiReleaseManifest {
  readonly schema: "vellum/linux-release-evidence/v1";
  readonly target: typeof LINUX_CI_TARGET;
  readonly source: {
    readonly commit: string;
    readonly sourceDateEpoch: number;
  };
  readonly publishable: {
    readonly format: "deb";
    readonly file: string;
  };
  readonly diagnostic: {
    readonly format: "tar.gz";
    readonly file: string;
  };
  readonly evidence: ReadonlyArray<{
    readonly scope: "release" | "evidence";
    readonly file: string;
    readonly bytes: number;
    readonly sha256: string;
  }>;
  readonly unsupported: readonly [
    "linux-arm64",
    "musl",
    "appimage",
    "snap",
    "flatpak",
    "rpm",
  ];
}

interface PackageIdentity {
  readonly productName: string;
  readonly version: string;
}

const requireNonEmpty = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`invalid ${label}`);
  }
  return value;
};

const requireHexCommit = (value: unknown): string => {
  const commit = requireNonEmpty(value, "source commit");
  if (!/^[0-9a-f]{40}$/u.test(commit)) {
    throw new Error("source commit must be a full lowercase Git SHA");
  }
  return commit;
};

const requireSourceDateEpoch = (value: unknown): number => {
  const epoch =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^[0-9]+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error("SOURCE_DATE_EPOCH must be a positive integer");
  }
  return epoch;
};

const readPackageIdentity = async (): Promise<PackageIdentity> => {
  const raw = JSON.parse(await readFile(packagePath, "utf8")) as {
    readonly version?: unknown;
    readonly build?: { readonly productName?: unknown };
  };
  return {
    productName: requireNonEmpty(raw.build?.productName, "product name"),
    version: requireNonEmpty(raw.version, "package version"),
  };
};

const readPackageVersion = async (name: string): Promise<string> => {
  const candidate = path.join(packageRoot, "node_modules", name, "package.json");
  const raw = JSON.parse(await readFile(candidate, "utf8")) as {
    readonly version?: unknown;
  };
  return requireNonEmpty(raw.version, `${name} version`);
};

const runFixed = (
  executable: string,
  args: ReadonlyArray<string>,
): string => {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    shell: false,
    timeout: 15_000,
    maxBuffer: 256 * 1024,
    env: {
      PATH:
        process.env.PATH ??
        "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      LANG: "C.UTF-8",
      LC_ALL: "C.UTF-8",
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(`${path.basename(executable)} failed during Linux CI inventory`);
  }
  return (result.stdout ?? "").trim();
};

export const parseUbuntuRelease = (input: string): "24.04" => {
  const fields = new Map<string, string>();
  for (const line of input.split(/\r?\n/u)) {
    const match = line.match(/^([A-Z_]+)=(?:"([^"]*)"|([^#\s]*))$/u);
    if (match !== null) fields.set(match[1], match[2] ?? match[3]);
  }
  if (fields.get("ID") !== "ubuntu" || fields.get("VERSION_ID") !== "24.04") {
    throw new Error("Linux release evidence requires exact Ubuntu 24.04");
  }
  return "24.04";
};

export const validateLinuxCiHost = (input: {
  readonly platform: string;
  readonly architecture: string;
  readonly machine: string;
  readonly glibc: string;
  readonly osRelease: string;
}): {
  readonly machine: "x86_64";
  readonly glibc: string;
  readonly ubuntu: "24.04";
} => {
  if (
    input.platform !== LINUX_CI_TARGET.os ||
    input.architecture !== LINUX_CI_TARGET.architecture ||
    input.machine !== LINUX_CI_TARGET.machine
  ) {
    throw new Error("Linux release evidence requires native Linux x64");
  }
  if (!/^glibc 2\.[0-9]+$/u.test(input.glibc)) {
    throw new Error("Linux release evidence requires glibc");
  }
  return {
    machine: "x86_64",
    glibc: input.glibc,
    ubuntu: parseUbuntuRelease(input.osRelease),
  };
};

export const collectLinuxCiInventory = async (input: {
  readonly commit: unknown;
  readonly sourceDateEpoch: unknown;
}): Promise<LinuxCiInventory> => {
  const host = validateLinuxCiHost({
    platform: process.platform,
    architecture: process.arch,
    machine: runFixed("/usr/bin/uname", ["-m"]),
    glibc: runFixed("/usr/bin/getconf", ["GNU_LIBC_VERSION"]),
    osRelease: await readFile("/etc/os-release", "utf8"),
  });
  return {
    schema: "vellum/linux-ci-inventory/v1",
    target: LINUX_CI_TARGET,
    source: {
      commit: requireHexCommit(input.commit),
      sourceDateEpoch: requireSourceDateEpoch(input.sourceDateEpoch),
    },
    runtime: {
      kernel: runFixed("/usr/bin/uname", ["-r"]),
      ...host,
    },
    tools: {
      bun: runFixed("/usr/bin/env", ["bun", "--version"]),
      node: runFixed("/usr/bin/env", ["node", "--version"]),
      electron: await readPackageVersion("electron"),
      nodePty: await readPackageVersion("node-pty"),
      electronBuilder: await readPackageVersion("electron-builder"),
      dpkg: runFixed("/usr/bin/dpkg", ["--version"]).split("\n")[0],
      dpkgDeb: runFixed("/usr/bin/dpkg-deb", ["--version"]).split("\n")[0],
    },
  };
};

export const createLinuxCiTestReceipt = (
  passedGates: ReadonlyArray<string>,
): LinuxCiTestReceipt => {
  const expected = new Set<string>(LINUX_CI_REQUIRED_GATES);
  const received = new Set<string>();
  for (const gate of passedGates) {
    if (!expected.has(gate)) throw new Error(`unknown Linux CI gate: ${gate}`);
    if (received.has(gate)) throw new Error(`duplicate Linux CI gate: ${gate}`);
    received.add(gate);
  }
  const missing = LINUX_CI_REQUIRED_GATES.filter((gate) => !received.has(gate));
  if (missing.length > 0) {
    throw new Error(`missing required Linux CI gates: ${missing.join(", ")}`);
  }
  return {
    schema: "vellum/linux-ci-test-receipt/v1",
    ok: true,
    target: LINUX_CI_TARGET,
    gates: LINUX_CI_REQUIRED_GATES.map((name) => ({ name, status: "passed" })),
  };
};

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/gu,
  /\bsk-[A-Za-z0-9_-]{20,}\b/gu,
  /\bAuthorization:\s*(?:Bearer|Basic)\s+\S+/giu,
  /\b(?:token|secret|password)\s*[=:]\s*["']?[A-Za-z0-9_./+=-]{24,}["']?/giu,
] as const;

export const findSecretBearingOutput = (input: string): boolean =>
  SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });

const replaceLiteral = (
  input: string,
  value: string | undefined,
  replacement: string,
): string =>
  value === undefined || value.length === 0
    ? input
    : input.replaceAll(value, replacement);

export const redactLinuxCiLog = (
  input: string,
  roots: {
    readonly workspace?: string;
    readonly home?: string;
    readonly runnerTemp?: string;
  } = {},
): { readonly output: string; readonly secretDetected: boolean } => {
  const secretDetected = findSecretBearingOutput(input);
  let output = input;
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    output = output.replace(pattern, "<redacted-secret>");
  }
  const replacements = [
    [roots.workspace, "<workspace>"],
    [roots.runnerTemp, "<runner-temp>"],
    [roots.home, "<home>"],
  ] as const;
  for (const [value, replacement] of [...replacements].sort(
    ([left], [right]) => (right?.length ?? 0) - (left?.length ?? 0),
  )) {
    output = replaceLiteral(output, value, replacement);
  }
  output = output
    .replaceAll(/\/home\/[^/\s]+/gu, "<home>")
    .replaceAll(/\/Users\/[^/\s]+/gu, "<home>");
  return { output, secretDetected };
};

const sha256File = async (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });

const isRegularFile = async (candidate: string): Promise<boolean> =>
  stat(candidate).then(
    (metadata) => metadata.isFile(),
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

const requireRelativeEvidencePath = (
  root: string,
  candidate: string,
): string => {
  const relative = path.relative(root, candidate);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Linux CI evidence path escaped its root");
  }
  return relative.split(path.sep).join("/");
};

export const validateLinuxReleaseArtifactNames = (input: {
  readonly names: ReadonlyArray<string>;
  readonly expectedDeb: string;
  readonly expectedDiagnostic: string;
}): void => {
  const debs = input.names.filter((name) => name.toLowerCase().endsWith(".deb"));
  if (debs.length !== 1 || debs[0] !== input.expectedDeb) {
    throw new Error("Linux release evidence requires one exact x64 deb");
  }
  if (!input.names.includes(input.expectedDiagnostic)) {
    throw new Error("Linux release evidence is missing the x64 diagnostic archive");
  }
  const forbidden = input.names.filter((name) =>
    /(?:arm64|aarch64|musl|appimage|\.snap(?:$|\.)|flatpak|\.rpm(?:$|\.)|linux-(?:generic|all))/iu.test(
      name,
    ),
  );
  if (forbidden.length > 0) {
    throw new Error(`unsupported Linux release artifact: ${forbidden.join(", ")}`);
  }
};

export const createLinuxCiReleaseManifest = async (input: {
  readonly releaseDirectory: string;
  readonly evidenceDirectory: string;
  readonly commit: unknown;
  readonly sourceDateEpoch: unknown;
}): Promise<LinuxCiReleaseManifest> => {
  const releaseDirectory = path.resolve(input.releaseDirectory);
  const evidenceDirectory = path.resolve(input.evidenceDirectory);
  const identity = await readPackageIdentity();
  const debName = linuxDebArtifactName({
    productName: identity.productName,
    version: identity.version,
    arch: "x64",
  });
  const unpackedName = linuxUnpackedArtifactName({
    productName: identity.productName,
    version: identity.version,
    arch: "x64",
  });
  const diagnosticName = `${unpackedName}.tar.gz`;
  const releaseNames = await readdir(releaseDirectory);
  const evidenceNames = await readdir(evidenceDirectory);
  validateLinuxReleaseArtifactNames({
    names: [...releaseNames, ...evidenceNames],
    expectedDeb: debName,
    expectedDiagnostic: diagnosticName,
  });

  const requiredEvidence = [
    "inventory.json",
    "package-audit.json",
    "packaged-pty-smoke.json",
    "packaged-runtime-smoke.json",
    "test-receipt.json",
  ] as const;
  const files = [
    path.join(releaseDirectory, debName),
    path.join(evidenceDirectory, diagnosticName),
    ...requiredEvidence.map((name) => path.join(evidenceDirectory, name)),
  ];
  const logDirectory = path.join(evidenceDirectory, "logs");
  const logNames = (await readdir(logDirectory)).filter((name) =>
    name.endsWith(".log"),
  ).sort();
  if (logNames.length === 0) {
    throw new Error("Linux release evidence requires sanitized logs");
  }
  files.push(...logNames.map((name) => path.join(logDirectory, name)));
  for (const file of files) {
    if (!(await isRegularFile(file))) {
      throw new Error(`Linux release evidence is missing ${path.basename(file)}`);
    }
  }

  const evidence = await Promise.all(files.map(async (file) => {
    const scope: "release" | "evidence" = file.startsWith(
      `${releaseDirectory}${path.sep}`,
    )
      ? "release"
      : "evidence";
    const root = scope === "release" ? releaseDirectory : evidenceDirectory;
    const metadata = await stat(file);
    return {
      scope,
      file: requireRelativeEvidencePath(root, file),
      bytes: metadata.size,
      sha256: await sha256File(file),
    };
  }));
  evidence.sort((left, right) => left.file.localeCompare(right.file));

  return {
    schema: "vellum/linux-release-evidence/v1",
    target: LINUX_CI_TARGET,
    source: {
      commit: requireHexCommit(input.commit),
      sourceDateEpoch: requireSourceDateEpoch(input.sourceDateEpoch),
    },
    publishable: { format: "deb", file: debName },
    diagnostic: { format: "tar.gz", file: diagnosticName },
    evidence,
    unsupported: [
      "linux-arm64",
      "musl",
      "appimage",
      "snap",
      "flatpak",
      "rpm",
    ],
  };
};

const decodeLinuxCiReleaseManifest = (
  value: unknown,
): LinuxCiReleaseManifest => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as { schema?: unknown }).schema !==
      "vellum/linux-release-evidence/v1"
  ) {
    throw new Error("malformed Linux release evidence manifest");
  }
  const manifest = value as LinuxCiReleaseManifest;
  if (JSON.stringify(manifest.target) !== JSON.stringify(LINUX_CI_TARGET)) {
    throw new Error("Linux release evidence target mismatch");
  }
  requireHexCommit(manifest.source?.commit);
  requireSourceDateEpoch(manifest.source?.sourceDateEpoch);
  if (
    manifest.publishable?.format !== "deb" ||
    manifest.diagnostic?.format !== "tar.gz" ||
    !Array.isArray(manifest.evidence) ||
    manifest.evidence.length === 0
  ) {
    throw new Error("Linux release evidence artifact contract mismatch");
  }
  return manifest;
};

export const verifyLinuxCiReleaseManifest = async (input: {
  readonly manifest: unknown;
  readonly releaseDirectory: string;
  readonly evidenceDirectory: string;
  readonly expectedCommit?: unknown;
}): Promise<LinuxCiReleaseManifest> => {
  const manifest = decodeLinuxCiReleaseManifest(input.manifest);
  if (
    input.expectedCommit !== undefined &&
    manifest.source.commit !== requireHexCommit(input.expectedCommit)
  ) {
    throw new Error("Linux release evidence source commit mismatch");
  }
  const releaseDirectory = path.resolve(input.releaseDirectory);
  const evidenceDirectory = path.resolve(input.evidenceDirectory);
  const identity = await readPackageIdentity();
  const expectedDeb = linuxDebArtifactName({
    productName: identity.productName,
    version: identity.version,
    arch: "x64",
  });
  const expectedDiagnostic = `${linuxUnpackedArtifactName({
    productName: identity.productName,
    version: identity.version,
    arch: "x64",
  })}.tar.gz`;
  if (
    manifest.publishable.file !== expectedDeb ||
    manifest.diagnostic.file !== expectedDiagnostic ||
    JSON.stringify(manifest.unsupported) !==
      JSON.stringify([
        "linux-arm64",
        "musl",
        "appimage",
        "snap",
        "flatpak",
        "rpm",
      ])
  ) {
    throw new Error("Linux release evidence support matrix mismatch");
  }
  const seen = new Set<string>();
  for (const entry of manifest.evidence) {
    if (
      (entry.scope !== "release" && entry.scope !== "evidence") ||
      typeof entry.file !== "string" ||
      typeof entry.bytes !== "number" ||
      !Number.isSafeInteger(entry.bytes) ||
      entry.bytes <= 0 ||
      typeof entry.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/u.test(entry.sha256)
    ) {
      throw new Error("malformed Linux release evidence entry");
    }
    const key = `${entry.scope}:${entry.file}`;
    if (seen.has(key)) throw new Error("duplicate Linux release evidence entry");
    seen.add(key);
    const root =
      entry.scope === "release" ? releaseDirectory : evidenceDirectory;
    const candidate = path.resolve(root, entry.file);
    requireRelativeEvidencePath(root, candidate);
    const metadata = await stat(candidate);
    if (
      !metadata.isFile() ||
      metadata.size !== entry.bytes ||
      (await sha256File(candidate)) !== entry.sha256
    ) {
      throw new Error(`Linux release evidence hash mismatch: ${entry.file}`);
    }
  }
  if (
    !seen.has(`release:${manifest.publishable.file}`) ||
    !seen.has(`evidence:${manifest.diagnostic.file}`)
  ) {
    throw new Error("Linux release evidence omits a declared artifact");
  }
  return manifest;
};

export const linuxCiChecksumLines = (
  manifest: LinuxCiReleaseManifest,
): string =>
  `${manifest.evidence
    .map(
      (entry) =>
        `${entry.sha256}  ${entry.scope}/${entry.file}`,
    )
    .sort()
    .join("\n")}\n`;

const writeJson = async (file: string, value: unknown): Promise<void> => {
  const target = path.resolve(file);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

const option = (
  args: ReadonlyArray<string>,
  name: string,
): string | undefined => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  const out = option(args, "--out");
  if (command === "inventory" && out !== undefined) {
    await writeJson(out, await collectLinuxCiInventory({
      commit: process.env.GITHUB_SHA,
      sourceDateEpoch: process.env.SOURCE_DATE_EPOCH,
    }));
    return;
  }
  if (command === "receipt" && out !== undefined) {
    const gates = args.flatMap((arg, index) =>
      arg === "--gate" && args[index + 1] !== undefined ? [args[index + 1]] : [],
    );
    await writeJson(out, createLinuxCiTestReceipt(gates));
    return;
  }
  if (command === "sanitize-log") {
    const source = option(args, "--input");
    if (source !== undefined && out !== undefined) {
      const sanitized = redactLinuxCiLog(await readFile(source, "utf8"), {
        workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
        runnerTemp: process.env.RUNNER_TEMP,
        home: process.env.HOME ?? homedir(),
      });
      await mkdir(path.dirname(path.resolve(out)), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(path.resolve(out), sanitized.output, {
        encoding: "utf8",
        mode: 0o600,
      });
      if (sanitized.secretDetected) {
        throw new Error("secret-bearing output detected in Linux CI log");
      }
      return;
    }
  }
  if (command === "manifest" && out !== undefined) {
    const releaseDirectory = option(args, "--release-dir");
    const evidenceDirectory = option(args, "--evidence-dir");
    if (releaseDirectory !== undefined && evidenceDirectory !== undefined) {
      const manifest = await createLinuxCiReleaseManifest({
        releaseDirectory,
        evidenceDirectory,
        commit: process.env.GITHUB_SHA,
        sourceDateEpoch: process.env.SOURCE_DATE_EPOCH,
      });
      await writeJson(out, manifest);
      await writeFile(
        path.join(path.dirname(path.resolve(out)), "SHA256SUMS"),
        linuxCiChecksumLines(manifest),
        { encoding: "utf8", mode: 0o600 },
      );
      return;
    }
  }
  if (command === "verify-manifest") {
    const manifestPath = option(args, "--manifest");
    const releaseDirectory = option(args, "--release-dir");
    const evidenceDirectory = option(args, "--evidence-dir");
    if (
      manifestPath !== undefined &&
      releaseDirectory !== undefined &&
      evidenceDirectory !== undefined
    ) {
      const manifest = await verifyLinuxCiReleaseManifest({
        manifest: JSON.parse(await readFile(manifestPath, "utf8")),
        releaseDirectory,
        evidenceDirectory,
        expectedCommit: process.env.GITHUB_SHA,
      });
      const checksums = await readFile(
        path.join(path.dirname(path.resolve(manifestPath)), "SHA256SUMS"),
        "utf8",
      );
      if (checksums !== linuxCiChecksumLines(manifest)) {
        throw new Error("Linux release checksum file mismatch");
      }
      process.stdout.write(
        `${JSON.stringify({
          ok: true,
          target: manifest.target,
          source: manifest.source,
        })}\n`,
      );
      return;
    }
  }
  throw new Error(
    "usage: linux-ci-evidence.ts inventory|receipt|sanitize-log|manifest [options]",
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
