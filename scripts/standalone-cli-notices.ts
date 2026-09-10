/** Preserve notices for both visible bundle inputs and prebundled runtime code. */
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}
interface InstalledPackage {
  readonly directory: string;
  readonly manifest: PackageManifest;
}

const LICENSE_PRIORITY = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "license",
  "license.md",
  "license.txt",
];
const LICENSE_NAME = /^(?:licen[sc]e|copying)(?:[._-].+)?$/i;
const NOTICE_NAME = /^(?:notice|copyright)(?:[._-].+)?$/i;
// This exact stock release embeds its five production dependencies in
// dist/{esm,commonjs}/index.min.js, hiding those inputs from Bun's metafile.
// Other packages are licensed from actual bundle inputs, not hypothetical
// declared dependencies that may be unused or platform-specific.
const PREBUNDLED_RUNTIME_PACKAGES = new Map([["tar", "7.5.15"]]);

const readManifest = (manifestPath: string): Record<string, unknown> => {
  const value: unknown = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`invalid CLI dependency manifest: ${manifestPath}`);
  }
  return value as Record<string, unknown>;
};

const dependencyMap = (
  value: unknown,
  label: string,
): Readonly<Record<string, string>> => {
  if (value === undefined) return {};
  if (
    typeof value !== "object" || value === null || Array.isArray(value) ||
    Object.entries(value).some(([name, range]) =>
      !/^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/.test(name) ||
      name === "." || name === ".." || typeof range !== "string" ||
      range.length === 0
    )
  ) {
    throw new Error(`invalid CLI dependency declarations: ${label}`);
  }
  return value as Readonly<Record<string, string>>;
};

const installedPackage = (directory: string): InstalledPackage => {
  const canonicalDirectory = realpathSync(directory);
  const raw = readManifest(join(canonicalDirectory, "package.json"));
  if (
    typeof raw.name !== "string" || raw.name.length === 0 ||
    typeof raw.version !== "string" || raw.version.length === 0
  ) {
    throw new Error(
      `CLI dependency lacks a package name and version: ${canonicalDirectory}`,
    );
  }
  return {
    directory: canonicalDirectory,
    manifest: {
      name: raw.name,
      version: raw.version,
      dependencies: dependencyMap(raw.dependencies, raw.name),
      optionalDependencies: dependencyMap(raw.optionalDependencies, raw.name),
    },
  };
};

/** Ignore module-format markers such as dist/esm/package.json with only type. */
const packageContaining = (file: string): InstalledPackage | undefined => {
  let directory = dirname(file);
  for (;;) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const value = readManifest(manifestPath);
      if (value.name !== undefined || value.version !== undefined) {
        return installedPackage(directory);
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
};

const resolveDependency = (
  owner: InstalledPackage,
  name: string,
): InstalledPackage | undefined => {
  const resolver = createRequire(join(owner.directory, "package.json"));
  for (const specifier of [`${name}/package.json`, name]) {
    try {
      const resolved = resolver.resolve(specifier);
      if (isAbsolute(resolved)) {
        const dependency = packageContaining(resolved);
        if (dependency !== undefined) return dependency;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code !== "MODULE_NOT_FOUND" && code !== "ERR_PACKAGE_PATH_NOT_EXPORTED"
      ) throw error;
    }
  }
  // Package exports can hide package.json and offer only import conditions.
  // Node's package lookup directories still identify the installed package
  // without executing its entry point or substituting a root-level version.
  for (const lookup of resolver.resolve.paths(name) ?? []) {
    const directory = join(lookup, name);
    if (existsSync(join(directory, "package.json"))) {
      return installedPackage(directory);
    }
  }
  return undefined;
};

const packageNotice = ({ directory, manifest }: InstalledPackage): string => {
  const entries = readdirSync(directory);
  const licenses = entries.filter((name) => LICENSE_NAME.test(name));
  if (licenses.length === 0) {
    throw new Error(
      `bundled CLI dependency lacks a retained license: ${manifest.name}@${manifest.version}`,
    );
  }
  const priority = (name: string): number => {
    const index = LICENSE_PRIORITY.indexOf(name);
    return index === -1 ? LICENSE_PRIORITY.length : index;
  };
  licenses.sort((left, right) =>
    priority(left) - priority(right) ||
    (left < right ? -1 : left > right ? 1 : 0)
  );
  const names = [
    ...licenses,
    ...entries.filter((name) => NOTICE_NAME.test(name)).sort(),
  ];
  const texts = names.map((name) => {
    const file = join(directory, name);
    if (!statSync(file).isFile()) {
      throw new Error(
        `CLI dependency notice is not a regular file: ${manifest.name}/${name}`,
      );
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(file),
    );
    if (text.trim().length === 0) {
      throw new Error(
        `CLI dependency notice is empty: ${manifest.name}/${name}`,
      );
    }
    return names.length === 1 ? text : `${name}\n\n${text}`;
  });
  return `${manifest.name}@${manifest.version}\n\n${texts.join("\n\n")}`;
};

export interface StandaloneCliNotices {
  /** Receipt compatibility: package names, sorted and unique across versions. */
  readonly dependencies: ReadonlyArray<string>;
  /** Third-party notice blocks only; the caller adds the application license. */
  readonly notices: ReadonlyArray<string>;
}

export const collectStandaloneCliNotices = (
  repoRoot: string,
  inputFiles: ReadonlyArray<string>,
): StandaloneCliNotices => {
  const packages = new Map<string, InstalledPackage>();
  const expanded = new Set<string>();
  const visit = (
    dependency: InstalledPackage,
    includeDependencies: boolean,
  ): void => {
    packages.set(dependency.directory, dependency);
    if (!includeDependencies || expanded.has(dependency.directory)) return;
    expanded.add(dependency.directory);
    const required = dependency.manifest.dependencies ?? {};
    const optional = dependency.manifest.optionalDependencies ?? {};
    for (
      const name of [
        ...new Set([...Object.keys(required), ...Object.keys(optional)]),
      ].sort()
    ) {
      const resolved = resolveDependency(dependency, name);
      if (resolved === undefined) {
        if (Object.hasOwn(optional, name)) continue;
        throw new Error(
          `bundled CLI dependency is missing a required dependency: ${dependency.manifest.name} -> ${name}`,
        );
      }
      visit(resolved, true);
    }
  };
  for (const input of inputFiles) {
    const path = resolve(repoRoot, input);
    if (!path.split(sep).includes("node_modules")) continue;
    const dependency = packageContaining(realpathSync(path));
    if (dependency === undefined) {
      throw new Error(`cannot identify bundled CLI dependency: ${input}`);
    }
    const prebundledVersion = PREBUNDLED_RUNTIME_PACKAGES.get(
      dependency.manifest.name,
    );
    if (
      prebundledVersion !== undefined &&
      dependency.manifest.version !== prebundledVersion
    ) {
      throw new Error(
        `CLI prebundled dependency notice policy requires review: ${dependency.manifest.name}@${dependency.manifest.version}`,
      );
    }
    visit(dependency, prebundledVersion !== undefined);
  }
  const dependencies = [
    ...new Set(
      [...packages.values()].map((dependency) => dependency.manifest.name),
    ),
  ].sort();
  const notices = [...new Set([...packages.values()].map(packageNotice))]
    .sort();
  return { dependencies, notices };
};
