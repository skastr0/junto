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

export const CODE_LAUNCHER_SOURCE = `import { plugin } from "bun";
import Module, { builtinModules } from "node:module";
import { readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const DIR = import.meta.dir;
const STEP = join(DIR, "step.ts");
const SDK = "junto/automation";
const BUILTIN = new Set(builtinModules);
const builtin = (name: string): boolean =>
  name.startsWith("node:") || name.startsWith("bun:") || name === "bun" || BUILTIN.has(name);
const refuse = (message: string): never => {
  writeSync(3, \`\${JSON.stringify({ kind: "fail", message })}\\n\`);
  process.exit(${CODE_LAUNCH_REFUSED_EXIT});
};
const only = (name: string): string =>
  \`A code step imports only junto/automation and the runtime's built-ins, not \${name}\`;

const built = await Bun.build({
  entrypoints: [STEP],
  target: "bun",
  format: "esm",
  throw: false,
  minify: { whitespace: true, syntax: true },
  plugins: [{
    name: "junto-code-imports",
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (args.path === STEP) return undefined;
        if (args.path === SDK) return { path: "sdk", namespace: "junto-sdk" };
        if (builtin(args.path)) return { path: args.path, external: true };
        throw new Error(only(args.path));
      });
      build.onLoad({ filter: /.*/, namespace: "junto-sdk" }, () => ({
        contents: readFileSync(join(DIR, "sdk.ts"), "utf8"),
        loader: "ts",
      }));
    },
  }],
});
if (!built.success) {
  refuse(\`The step's code does not build: \${built.logs.map((log) => String(log.message ?? log)).join("; ")}\`);
}
const code = await built.outputs[0].text();
if (/\\bimport\\s*\\(\\s*(?![\\x22\\x27])/.test(code)) {
  refuse("A code step imports by name: import() with a computed name is refused");
}

const resolve = (Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename;
(Module as unknown as { _resolveFilename: (request: string, ...rest: unknown[]) => string })._resolveFilename =
  function (this: unknown, request: string, ...rest: unknown[]): string {
    if (builtin(request)) return resolve.call(this, request, ...rest);
    throw new Error(only(request));
  };

plugin({
  name: "junto-code-step",
  setup(build) {
    build.onResolve({ filter: /^step$/, namespace: "junto-code" }, () => ({ path: "step", namespace: "junto-code" }));
    build.onLoad({ filter: /.*/, namespace: "junto-code" }, () => ({ contents: code, loader: "js" }));
  },
});
await import("junto-code:step");
`;
