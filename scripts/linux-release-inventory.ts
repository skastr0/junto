import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface InstalledPackageLicense {
  readonly name: string;
  readonly version: string;
  readonly direct: boolean;
  readonly development: boolean;
  readonly license: string;
  readonly licenseSource:
    | "package-metadata"
    | "bundled-license-file"
    | "unresolved";
  readonly licenseEvidence?: {
    readonly file: string;
    readonly sha256: string;
  };
  readonly purl: string;
}

export interface DependencyLicenseInventory {
  readonly schema: "vellum/dependency-license-inventory/v1";
  readonly sourceRevision: string;
  readonly packages: ReadonlyArray<InstalledPackageLicense>;
  readonly unknownLicenseCount: number;
}

interface RootPackage {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly devDependencies?: Readonly<Record<string, unknown>>;
}

const SOURCE_REVISION = /^[0-9a-f]{40}$/u;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/iu;
const PACKAGE_VERSION = /^[^\s\0]{1,128}$/u;
const MAX_LICENSE_FILE_BYTES = 128 * 1024;
const LICENSE_FILE_NAMES = [
  "LICENSE",
  "LICENSE.txt",
  "LICENSE.md",
  "LICENCE",
  "LICENCE.txt",
  "LICENCE.md",
  "COPYING",
] as const;

const requireRevision = (value: unknown): string => {
  if (typeof value !== "string" || !SOURCE_REVISION.test(value)) {
    throw new Error("source revision must be a full lowercase Git SHA");
  }
  return value;
};

const requirePackageText = (
  value: unknown,
  pattern: RegExp,
  label: string,
): string => {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid installed package ${label}`);
  }
  return value;
};

const normalizeLicense = (value: unknown): string => {
  const candidate =
    typeof value === "string"
      ? value
      : Array.isArray(value)
        ? value
          .flatMap((entry) =>
            typeof entry === "string"
              ? [entry]
              : typeof entry === "object" &&
                  entry !== null &&
                  typeof (entry as { type?: unknown }).type === "string"
                ? [(entry as { type: string }).type]
                : []
          )
          .join(" OR ")
        : "";
  return candidate.length > 0 &&
      Buffer.byteLength(candidate, "utf8") <= 256 &&
      !/[\0\r\n]/u.test(candidate)
    ? candidate
    : "UNKNOWN";
};

interface BundledLicenseEvidence {
  readonly license: string;
  readonly file: string;
  readonly sha256: string;
}

const errno = (error: unknown): string | undefined =>
  error instanceof Error && "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
    ? (error as { readonly code: string }).code
    : undefined;

const identifyBundledLicense = (text: string): string => {
  const normalized = text.replaceAll("\r\n", "\n");
  return normalized.startsWith("MIT License\n") &&
      normalized.includes(
        "Permission is hereby granted, free of charge, to any person obtaining a copy",
      ) &&
      normalized.includes('THE SOFTWARE IS PROVIDED "AS IS"')
    ? "MIT"
    : "UNKNOWN";
};

const inspectBundledLicense = async (
  packageDirectory: string,
): Promise<BundledLicenseEvidence | undefined> => {
  let unresolved: BundledLicenseEvidence | undefined;
  for (const file of LICENSE_FILE_NAMES) {
    const candidate = path.join(packageDirectory, file);
    let handle;
    try {
      handle = await open(
        candidate,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
    } catch (error) {
      if (errno(error) === "ENOENT" || errno(error) === "ELOOP") continue;
      throw error;
    }
    try {
      const metadata = await handle.stat();
      if (
        !metadata.isFile() ||
        metadata.size <= 0 ||
        metadata.size > MAX_LICENSE_FILE_BYTES
      ) {
        continue;
      }
      const bytes = await handle.readFile();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        continue;
      }
      const evidence = {
        license: identifyBundledLicense(text),
        file,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      if (evidence.license !== "UNKNOWN") return evidence;
      unresolved ??= evidence;
    } finally {
      await handle.close();
    }
  }
  return unresolved;
};

const npmPurl = (name: string, version: string): string => {
  const encodedName = name.startsWith("@")
    ? `%40${name.slice(1).split("/").map(encodeURIComponent).join("/")}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${encodeURIComponent(version)}`;
};

const packageDirectories = async (
  nodeModulesDirectory: string,
): Promise<ReadonlyArray<string>> => {
  const directories: string[] = [];
  const visitNodeModules = async (root: string): Promise<void> => {
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || !entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scope = path.join(root, entry.name);
        for (const child of await readdir(scope, { withFileTypes: true })) {
          if (child.name.startsWith(".") || !child.isDirectory()) continue;
          const packageRoot = path.join(scope, child.name);
          directories.push(packageRoot);
          const nested = path.join(packageRoot, "node_modules");
          try {
            const metadata = await lstat(nested);
            if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
              await visitNodeModules(nested);
            }
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              error.code !== "ENOENT"
            ) {
              throw error;
            }
          }
        }
      } else {
        const packageRoot = path.join(root, entry.name);
        directories.push(packageRoot);
        const nested = path.join(packageRoot, "node_modules");
        try {
          const metadata = await lstat(nested);
          if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
            await visitNodeModules(nested);
          }
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !("code" in error) ||
            error.code !== "ENOENT"
          ) {
            throw error;
          }
        }
      }
    }
  };
  await visitNodeModules(nodeModulesDirectory);
  return directories.sort();
};

const readJson = async (file: string, label: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    throw new Error(`could not decode ${label}`);
  }
};

export const collectDependencyLicenseInventory = async (input: {
  readonly projectDirectory: string;
  readonly nodeModulesDirectory: string;
  readonly sourceRevision: string;
}): Promise<DependencyLicenseInventory> => {
  const projectDirectory = path.resolve(input.projectDirectory);
  const nodeModulesDirectory = path.resolve(input.nodeModulesDirectory);
  const root = await readJson(
    path.join(projectDirectory, "package.json"),
    "root package",
  ) as RootPackage;
  const runtime = new Set(Object.keys(root.dependencies ?? {}));
  const development = new Set(Object.keys(root.devDependencies ?? {}));
  const packages = new Map<string, InstalledPackageLicense>();

  for (const directory of await packageDirectories(nodeModulesDirectory)) {
    const metadata = await lstat(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("dependency inventory refuses symbolic package roots");
    }
    const packageJson = await readJson(
      path.join(directory, "package.json"),
      "installed package",
    ) as {
      readonly name?: unknown;
      readonly version?: unknown;
      readonly license?: unknown;
      readonly licenses?: unknown;
    };
    const name = requirePackageText(packageJson.name, PACKAGE_NAME, "name");
    const version = requirePackageText(
      packageJson.version,
      PACKAGE_VERSION,
      "version",
    );
    const metadataLicense = normalizeLicense(
      packageJson.license ?? packageJson.licenses,
    );
    const bundledLicense = metadataLicense === "UNKNOWN"
      ? await inspectBundledLicense(directory)
      : undefined;
    const license = bundledLicense?.license ?? metadataLicense;
    const key = `${name}\0${version}`;
    packages.set(key, {
      name,
      version,
      direct: runtime.has(name) || development.has(name),
      development: development.has(name) && !runtime.has(name),
      license,
      licenseSource: metadataLicense !== "UNKNOWN"
        ? "package-metadata"
        : license !== "UNKNOWN"
          ? "bundled-license-file"
          : "unresolved",
      ...(bundledLicense === undefined
        ? {}
        : {
          licenseEvidence: {
            file: bundledLicense.file,
            sha256: bundledLicense.sha256,
          },
        }),
      purl: npmPurl(name, version),
    });
  }
  const sorted = [...packages.values()].sort((left, right) =>
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version)
  );
  return {
    schema: "vellum/dependency-license-inventory/v1",
    sourceRevision: requireRevision(input.sourceRevision),
    packages: sorted,
    unknownLicenseCount: sorted.filter((entry) => entry.license === "UNKNOWN")
      .length,
  };
};

export const createCycloneDxSbom = (input: {
  readonly inventory: DependencyLicenseInventory;
  readonly productName: string;
  readonly productVersion: string;
  readonly sourceDateEpoch: number;
}): Readonly<Record<string, unknown>> => {
  if (
    !Number.isSafeInteger(input.sourceDateEpoch) ||
    input.sourceDateEpoch <= 0
  ) {
    throw new Error("SOURCE_DATE_EPOCH must be a positive integer");
  }
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    version: 1,
    metadata: {
      timestamp: new Date(input.sourceDateEpoch * 1_000).toISOString(),
      component: {
        type: "application",
        name: input.productName,
        version: input.productVersion,
        properties: [
          {
            name: "vellum:source-revision",
            value: input.inventory.sourceRevision,
          },
        ],
      },
    },
    components: input.inventory.packages.map((entry) => ({
      type: "library",
      name: entry.name,
      version: entry.version,
      purl: entry.purl,
      licenses: [
        entry.license === "UNKNOWN"
          ? { license: { name: "UNKNOWN" } }
          : { expression: entry.license },
      ],
      properties: [
        { name: "vellum:direct", value: String(entry.direct) },
        { name: "vellum:development", value: String(entry.development) },
        { name: "vellum:license-source", value: entry.licenseSource },
        ...(entry.licenseEvidence === undefined
          ? []
          : [
            {
              name: "vellum:license-evidence-file",
              value: entry.licenseEvidence.file,
            },
            {
              name: "vellum:license-evidence-sha256",
              value: entry.licenseEvidence.sha256,
            },
          ]),
      ],
    })),
  };
};

const writeJsonExclusive = async (
  target: string,
  value: unknown,
): Promise<void> => {
  const file = path.resolve(target);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o644,
  });
};

const parseOptions = (args: ReadonlyArray<string>): Map<string, string> => {
  const allowed = new Set([
    "--project",
    "--node-modules",
    "--source-revision",
    "--source-date-epoch",
    "--license-out",
    "--sbom-out",
    "--source-out",
  ]);
  const parsed = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (
      name === undefined ||
      value === undefined ||
      !allowed.has(name) ||
      parsed.has(name)
    ) {
      throw new Error("invalid Linux release inventory option");
    }
    parsed.set(name, value);
  }
  return parsed;
};

const required = (options: Map<string, string>, name: string): string => {
  const value = options.get(name);
  if (value === undefined) throw new Error(`missing required option: ${name}`);
  return value;
};

export const linuxReleaseInventoryMain = async (
  args: ReadonlyArray<string>,
): Promise<void> => {
  const options = parseOptions(args);
  const project = path.resolve(required(options, "--project"));
  const sourceRevision = required(options, "--source-revision");
  const root = await readJson(
    path.join(project, "package.json"),
    "root package",
  ) as RootPackage;
  const name = requirePackageText(root.name, PACKAGE_NAME, "root name");
  const version = requirePackageText(
    root.version,
    PACKAGE_VERSION,
    "root version",
  );
  const sourceDateEpoch = Number(required(options, "--source-date-epoch"));
  const inventory = await collectDependencyLicenseInventory({
    projectDirectory: project,
    nodeModulesDirectory: required(options, "--node-modules"),
    sourceRevision,
  });
  await Promise.all([
    writeJsonExclusive(required(options, "--license-out"), inventory),
    writeJsonExclusive(
      required(options, "--sbom-out"),
      createCycloneDxSbom({
        inventory,
        productName: name,
        productVersion: version,
        sourceDateEpoch,
      }),
    ),
    writeJsonExclusive(required(options, "--source-out"), {
      schema: "vellum/source-revision/v1",
      revision: requireRevision(sourceRevision),
    }),
  ]);
  process.stdout.write(
    `${JSON.stringify({
      ok: true,
      packages: inventory.packages.length,
      unknownLicenses: inventory.unknownLicenseCount,
      sourceRevision: inventory.sourceRevision,
    })}\n`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  linuxReleaseInventoryMain(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`Linux release inventory failed: ${message}\n`);
    process.exitCode = 1;
  });
}
