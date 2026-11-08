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
 * `junto/change-names-its-subject` holds that a change notice says what
 * changed. A notice that names only its scope (a canvas, a channel, a kind)
 * makes every reader re-read the whole scope on every write: the shape behind
 * a run of perf fixes in which one write re-read the world (4c919860d, the
 * artifact push that re-read 29 nodes, 4.6 MB, per write; 656ed5ff7;
 * 6006c5ea5; 16b4096be). It reads three declarations: a `Schema.Struct`
 * bound to a name ending in `Changed`, `ChangedPush`, `ChangedNotice`,
 * `ChangedEvent` or `ChangedPayload`; a type or interface with such a name;
 * and an emitter named `note|emit|notify|publish|announce...Changed`. One
 * whose every member is a SCOPE_WORDS name (canvasName, channel, kind...) is
 * reported. A notice that truly means its whole scope says so where it is
 * declared, with an oxlint-disable comment that gives the reason and the size
 * of what a reader re-reads. Today's coarse notices sit in the rule's `known`
 * ledger, which may only shrink.
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

/**
 * Names that say only where a change happened, never what changed. A notice
 * or emitter whose every member is one of these names no subject. The set is
 * closed on purpose: a member that is anything else (`nodeIds`, `squads`,
 * `next`, `event`) carries the change or its data, and passes.
 */
export const SCOPE_WORDS: ReadonlySet<string> = new Set([
  "_tag", "at", "canvas", "canvasId", "canvasName", "channel", "domain", "home", "kind", "machine", "machineId",
  "machineName", "origin", "reason", "scope", "seq", "source", "tag", "type", "version", "workspace", "workspaceId",
]);

/** A declaration named as a change notice: `ResourceChangedPush`, `MentionChanged`, never a bare `Changed`. */
export const NOTICE_NAME = /.Changed(?:Push|Notice|Event|Payload)?$/u;
/** An emitter named as one: `noteResourceChanged`, `emitAgentSignalChanged`. */
export const EMITTER_NAME = /^(?:note|emit|notify|publish|announce)[A-Z]\w*Changed$/u;

export type ChangeNoticeOptions = {
  /**
   * Notices that name no subject today, each as `<repo-relative path>#<name>`:
   * the debt ledger. A listed one passes; a listed one that has come to name
   * its subject is reported, so the ledger only shrinks.
   */
  readonly known?: ReadonlyArray<string>;
  /** The repo root; defaults to the working directory oxlint runs in. */
  readonly root?: string;
};

/** Why a notice names no subject, or undefined when it names one (or its members cannot be read here). */
export const coarseNotice = (what: "notice" | "emitter", name: string, members: ReadonlyArray<string> | undefined): string | undefined => {
  if (members === undefined || !members.every((member) => SCOPE_WORDS.has(member))) return undefined;
  const carried = members.length === 0 ? "nothing" : members.join(", ");
  return what === "notice"
    ? `${name} carries only ${carried}: name what changed (an optional ids field, absent meaning the whole scope), or every reader re-reads the scope on each write`
    : `${name} takes only ${carried}: pass what changed (ids, absent meaning the whole scope), or every listener re-reads the scope on each call`;
};

/** The verdict for one declaration, given the ledger: a message to report, or undefined. */
export const noticeVerdict = (
  what: "notice" | "emitter",
  rel: string,
  name: string,
  members: ReadonlyArray<string> | undefined,
  known: ReadonlySet<string>,
): string | undefined => {
  const coarse = coarseNotice(what, name, members);
  const key = `${rel}#${name}`;
  if (!known.has(key)) return coarse;
  if (coarse !== undefined || members === undefined) return undefined;
  return `${name} now names what changed: drop ${key} from the known list of junto/change-names-its-subject in .oxlintrc.json`;
};

type AnyNode = { readonly type: string; readonly [key: string]: unknown };

const nameOfKey = (key: unknown): string | undefined => {
  const node = key as AnyNode | undefined;
  if (node === undefined) return undefined;
  if (node.type === "Identifier") return node.name as string;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
};

/** The keys of an object literal; undefined when a spread or a computed key hides some. */
const objectKeys = (object: AnyNode): ReadonlyArray<string> | undefined => {
  const keys: Array<string> = [];
  for (const property of object.properties as ReadonlyArray<AnyNode>) {
    if (property.type !== "Property" || property.computed === true) return undefined;
    const key = nameOfKey(property.key);
    if (key === undefined) return undefined;
    keys.push(key);
  }
  return keys;
};

/** The member names of a type literal or interface body; undefined when one cannot be read. */
const typeMembers = (members: ReadonlyArray<AnyNode>): ReadonlyArray<string> | undefined => {
  const names: Array<string> = [];
  for (const member of members) {
    if (member.type !== "TSPropertySignature" || member.computed === true) return undefined;
    const key = nameOfKey(member.key);
    if (key === undefined) return undefined;
    names.push(key);
  }
  return names;
};

/** Parameter names; undefined when a destructured or rest parameter hides them. */
const paramNames = (params: ReadonlyArray<AnyNode>): ReadonlyArray<string> | undefined => {
  const names: Array<string> = [];
  for (const param of params) {
    const target = param.type === "AssignmentPattern" ? (param.left as AnyNode) : param;
    if (target.type !== "Identifier") return undefined;
    names.push(target.name as string);
  }
  return names;
};

/** `Schema.Struct({...})`: its object argument. */
const structObject = (init: AnyNode | null | undefined): AnyNode | undefined => {
  if (init?.type !== "CallExpression") return undefined;
  const callee = init.callee as AnyNode;
  const args = init.arguments as ReadonlyArray<AnyNode>;
  const isStruct =
    callee.type === "MemberExpression" && nameOfKey(callee.property) === "Struct" && nameOfKey(callee.object) === "Schema";
  return isStruct && args[0]?.type === "ObjectExpression" ? args[0] : undefined;
};

const isFunction = (node: AnyNode | null | undefined): boolean =>
  node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";

const changeNamesItsSubject = {
  meta: {
    type: "problem",
    docs: { description: "A change notice names what changed, not only its scope." },
    schema: [{ type: "object" }],
  },
  create(context: Context) {
    const options = context.options[0] as ChangeNoticeOptions | undefined;
    const known: ReadonlySet<string> = new Set(options?.known ?? []);
    const root = options?.root ?? context.cwd ?? process.cwd();
    const rel = path.relative(root, context.filename).split(path.sep).join("/");
    const judge = (node: unknown, what: "notice" | "emitter", name: string, members: ReadonlyArray<string> | undefined): void => {
      const message = noticeVerdict(what, rel, name, members, known);
      if (message !== undefined) context.report({ node, message });
    };
    return {
      VariableDeclarator: (node: AnyNode) => {
        const id = node.id as AnyNode;
        if (id.type !== "Identifier") return;
        const name = id.name as string;
        const init = node.init as AnyNode | null;
        if (NOTICE_NAME.test(name)) {
          const object = structObject(init);
          if (object !== undefined) judge(id, "notice", name, objectKeys(object));
        }
        if (EMITTER_NAME.test(name) && isFunction(init)) {
          judge(id, "emitter", name, paramNames(init!.params as ReadonlyArray<AnyNode>));
        }
      },
      FunctionDeclaration: (node: AnyNode) => {
        const id = node.id as AnyNode | null;
        if (id?.type !== "Identifier" || !EMITTER_NAME.test(id.name as string)) return;
        judge(id, "emitter", id.name as string, paramNames(node.params as ReadonlyArray<AnyNode>));
      },
      TSTypeAliasDeclaration: (node: AnyNode) => {
        const id = node.id as AnyNode;
        const annotation = node.typeAnnotation as AnyNode;
        if (!NOTICE_NAME.test(id.name as string) || annotation.type !== "TSTypeLiteral") return;
        judge(id, "notice", id.name as string, typeMembers(annotation.members as ReadonlyArray<AnyNode>));
      },
      TSInterfaceDeclaration: (node: AnyNode) => {
        const id = node.id as AnyNode;
        if (!NOTICE_NAME.test(id.name as string) || ((node.extends as ReadonlyArray<unknown> | undefined) ?? []).length > 0) return;
        judge(id, "notice", id.name as string, typeMembers((node.body as AnyNode).body as ReadonlyArray<AnyNode>));
      },
    };
  },
};

export default {
  meta: { name: "junto" },
  rules: { "program-imports": programImports, "change-names-its-subject": changeNamesItsSubject },
};
