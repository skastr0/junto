/**
 * Junto's own oxlint rules (`.oxlintrc.json` loads this file as a JS plugin;
 * oxlint runs TypeScript plugins natively under Node 22.18 and later).
 *
 * `junto/program-imports` holds the dependency graph between Junto's
 * programs: the app (Electron main), the core, the terminal process, the
 * window, the preload, the CLI and the code they share. Each program is a set
 * of path prefixes; a file belongs to the program with the longest prefix
 * that matches it. A file may import its own program and the programs listed
 * in `mayImport`, and never a module in `forbidModules`. Type-only imports
 * are erased at build, so they pass unless `typeImports` is "check".
 *
 * Inside one compiler project no type checker can refuse an import; this rule
 * is where that refusal lives (operator, signal 01M6T9A1FFD0AMCMEY5XQDTG35).
 *
 * Plugin code is erasable TypeScript only (no enums, no parameter
 * properties), so Node runs it by stripping types.
 */
import path from "node:path";

export type ProgramSpec = {
  readonly name: string;
  /** Repo-relative path prefixes: a folder ends in `/`, a file is named whole. */
  readonly paths: ReadonlyArray<string>;
  /** Other programs this one may import. Its own program is always allowed. */
  readonly mayImport?: ReadonlyArray<string>;
  /** Package names this program never loads, such as `electron`. */
  readonly forbidModules?: ReadonlyArray<string>;
  /** "allow" (default): `import type` and all-type specifiers pass. "check": they are held too. */
  readonly typeImports?: "allow" | "check";
};

export type ProgramImportsOptions = {
  readonly programs: ReadonlyArray<ProgramSpec>;
  /** Import aliases to repo-relative prefixes, as in tsconfig `paths`. */
  readonly aliases?: Readonly<Record<string, string>>;
  /** The repo root; defaults to the working directory oxlint runs in. */
  readonly root?: string;
};

type Program = ProgramSpec & { readonly allowed: ReadonlySet<string> };

/** The program a repo-relative path belongs to: the longest matching prefix wins. */
export const programOf = (programs: ReadonlyArray<ProgramSpec>, rel: string): ProgramSpec | undefined => {
  let best: { readonly program: ProgramSpec; readonly length: number } | undefined;
  for (const program of programs) {
    for (const prefix of program.paths) {
      const hit = prefix.endsWith("/") ? rel.startsWith(prefix) : rel === prefix || rel.startsWith(`${prefix.replace(/\.[cm]?[jt]sx?$/u, "")}.`);
      if (hit && (best === undefined || prefix.length > best.length)) best = { program, length: prefix.length };
    }
  }
  return best?.program;
};

/** `@scope/name/sub` is `@scope/name`; `name/sub` is `name`; `node:fs` is `node:fs`. */
export const packageOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
};

/**
 * Where an import specifier points: a repo-relative path for a relative or
 * aliased import, or a package name. Query suffixes (`?nodeWorker`) are cut.
 */
export const targetOf = (
  specifier: string,
  fromRel: string,
  aliases: Readonly<Record<string, string>>,
): { readonly kind: "path"; readonly rel: string } | { readonly kind: "package"; readonly name: string } => {
  const bare = specifier.replace(/\?.*$/u, "");
  if (bare.startsWith(".")) return { kind: "path", rel: path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), bare)) };
  for (const [alias, target] of Object.entries(aliases)) {
    const exact = alias.endsWith("/*") ? undefined : alias;
    const prefix = alias.endsWith("/*") ? alias.slice(0, -1) : undefined;
    if (exact !== undefined && bare === exact) return { kind: "path", rel: target };
    if (prefix !== undefined && bare.startsWith(prefix)) return { kind: "path", rel: target.replace(/\*$/u, "") + bare.slice(prefix.length) };
  }
  return { kind: "package", name: packageOf(bare) };
};

/** Why an import breaks the graph, or undefined when it is allowed. */
export const importViolation = (
  options: ProgramImportsOptions,
  fromRel: string,
  specifier: string,
): string | undefined => {
  const from = programOf(options.programs, fromRel);
  if (from === undefined) return undefined;
  const target = targetOf(specifier, fromRel, options.aliases ?? {});
  if (target.kind === "package") {
    return from.forbidModules?.includes(target.name) ? `the ${from.name} program never loads "${target.name}"` : undefined;
  }
  const to = programOf(options.programs, target.rel);
  if (to === undefined || to.name === from.name || (from.mayImport ?? []).includes(to.name)) return undefined;
  return `the ${from.name} program may not import the ${to.name} program (${target.rel})`;
};

type Node = {
  readonly type: string;
  readonly importKind?: "type" | "value";
  readonly exportKind?: "type" | "value";
  readonly source?: { readonly type: string; readonly value?: unknown } | null;
  readonly specifiers?: ReadonlyArray<{ readonly importKind?: "type" | "value"; readonly exportKind?: "type" | "value" }>;
};

type Context = {
  readonly filename: string;
  readonly cwd?: string;
  readonly options: ReadonlyArray<unknown>;
  readonly report: (descriptor: { readonly node: unknown; readonly message: string }) => void;
};

/** An import or export whose every binding is a type: erased at build. */
const typeOnly = (node: Node): boolean => {
  if (node.importKind === "type" || node.exportKind === "type") return true;
  const specifiers = node.specifiers ?? [];
  return specifiers.length > 0 && specifiers.every((specifier) => specifier.importKind === "type" || specifier.exportKind === "type");
};

const programImports = {
  meta: {
    type: "problem",
    docs: { description: "Hold the import graph between Junto's programs." },
    schema: [{ type: "object" }],
  },
  create(context: Context) {
    const options = context.options[0] as ProgramImportsOptions | undefined;
    if (options === undefined) return {};
    const root = options.root ?? context.cwd ?? process.cwd();
    const fromRel = path.relative(root, context.filename).split(path.sep).join("/");
    const from = programOf(options.programs, fromRel);
    if (from === undefined) return {};
    const checkTypes = from.typeImports === "check";
    const check = (node: Node, source: Node["source"]): void => {
      if (source === null || source === undefined || source.type !== "Literal" || typeof source.value !== "string") return;
      if (!checkTypes && typeOnly(node)) return;
      const message = importViolation(options, fromRel, source.value);
      if (message !== undefined) context.report({ node: source, message });
    };
    return {
      ImportDeclaration: (node: Node) => check(node, node.source),
      ExportNamedDeclaration: (node: Node) => check(node, node.source),
      ExportAllDeclaration: (node: Node) => check(node, node.source),
      ImportExpression: (node: Node) => check(node, node.source),
    };
  },
};

export default {
  meta: { name: "junto" },
  rules: { "program-imports": programImports },
};
