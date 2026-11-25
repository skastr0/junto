/**
 * What a TypeScript code step runs with (plan 0.11/05, Code steps): the SDK
 * it imports as `junto/automation`, and the launcher that runs it.
 *
 * The SDK reads the step's input, which the runner writes to stdin as JSON,
 * and writes one result line to fd 3, where the runner reads it. It has no
 * Junto operations: it reads and answers, nothing else.
 *
 * The launcher holds the doctrine's import rule (docs/security-doctrine.md,
 * Code steps): imports resolve only to the SDK and the runtime's built-ins,
 * never to a package in a folder. Bun's runtime resolver takes no hook for a
 * module's own imports (bun 1.4.3), so the launcher bundles the step in memory
 * with a resolver that refuses everything else, runs the bundle as a module
 * with no folder, refuses `require` of anything but a built-in, and refuses
 * an `import()` whose name is computed. That keeps folders from changing what
 * a step means; it is not a sandbox against its own author.
 */

export const CODE_SDK_SOURCE = `/**
 * junto/automation: the input of this code step, and its answer.
 *
 *   import { input, cont, stop, fail } from "junto/automation";
 *   const { values } = input();
 *   cont({ summary: \`\${values["task.title"]} checked\` });
 *
 * Answer once: cont, stop and fail end the process. With no answer, exit 0
 * continues with no output and any other exit fails with its code.
 */
import { readFileSync, writeSync } from "node:fs";

export type Value = string | number | boolean;

export type Input = {
  readonly automation: { readonly automationId: string; readonly name: string; readonly nodeId: string };
  readonly firing: { readonly firingId: string; readonly at: number; readonly cause: string };
  readonly trigger: unknown;
  readonly event: unknown;
  /** The trigger's values and each earlier code step's output, by name: "task.title", "code.summary". */
  readonly values: Readonly<Record<string, string>>;
  /** Under an artifact trigger, the artifact that fired it, its body as structured data. */
  readonly artifact?: {
    readonly artifactId: string;
    readonly nodeId: string;
    readonly title: string;
    readonly version: number;
    readonly labels: ReadonlyArray<string>;
    readonly body: unknown;
  };
};

const RESULT_FD = 3;
let read: Input | undefined;

/** The step's input, read from stdin once. */
export const input = (): Input => read ??= JSON.parse(readFileSync(0, "utf8")) as Input;

/** One value of the firing, or undefined when it does not carry that name. */
export const value = (name: string): string | undefined => input().values[name];

const answer = (result: object, exitCode: number): never => {
  writeSync(RESULT_FD, \`\${JSON.stringify(result)}\\n\`);
  process.exit(exitCode);
};

/** Continue the firing; each field becomes {{code.<field>}} for the steps after this one. */
export const cont = (output: Readonly<Record<string, Value>> = {}): never => answer({ kind: "continue", output }, 0);

/** End the firing here: the steps after this one do not run. */
export const stop = (reason?: string): never => answer(reason === undefined ? { kind: "stop" } : { kind: "stop", reason }, 0);

/** Fail the firing with a message a person reads. */
export const fail = (message: string): never => answer({ kind: "fail", message }, 1);
`;

/** Refusals the launcher answers on fd 3 before the step runs. */
export const CODE_LAUNCH_REFUSED_EXIT = 70;

/**
 * The launcher the runtime runs: the machine's Node, which strips the step's
 * types itself. It is plain JavaScript, so it means the same on every Node
 * that runs it. Before the step loads, a resolve hook closes every import
 * form (static, `import()`, `require`) to the SDK and the runtime's
 * built-ins; a folder's `node_modules`, `package.json` imports or
 * `tsconfig.json` paths never resolve.
 */
export const CODE_LAUNCHER_SOURCE = `import { builtinModules, createRequire, registerHooks } from "node:module";
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DIR = import.meta.dirname;
const STEP_PATH = join(DIR, "step.ts");
const STEP = pathToFileURL(STEP_PATH).href;
const SDK_URL = pathToFileURL(join(DIR, "sdk.ts")).href;
const SDK = "junto/automation";
const REFUSED = "JUNTO_CODE_IMPORT_REFUSED";
const BUILTIN = new Set(builtinModules);
const builtin = (name) => name.startsWith("node:") || BUILTIN.has(name);
const refuse = (message) => {
  writeSync(3, \`\${JSON.stringify({ kind: "fail", message })}\\n\`);
  process.exit(${CODE_LAUNCH_REFUSED_EXIT});
};
const only = (name) =>
  \`A code step imports only junto/automation and the runtime's built-ins, not \${name}\`;

if (/\\bimport\\s*\\(\\s*(?![\\x22\\x27])/.test(readFileSync(STEP_PATH, "utf8"))) {
  refuse("A code step imports by name: import() with a computed name is refused");
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === SDK) return { url: SDK_URL, format: "module-typescript", shortCircuit: true };
    if (specifier === STEP || builtin(specifier)) return nextResolve(specifier, context);
    throw Object.assign(new Error(only(specifier)), { code: REFUSED });
  },
});
// A step may require a built-in from its module, as it may import one.
globalThis.require = createRequire(STEP_PATH);

try {
  await import(STEP);
} catch (error) {
  const code = error?.code;
  if (code === REFUSED) refuse(error.message);
  if (code === "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX" || code === "ERR_INVALID_TYPESCRIPT_SYNTAX") {
    refuse(\`The step's code does not build: \${error.message}\`);
  }
  throw error;
}
`;
