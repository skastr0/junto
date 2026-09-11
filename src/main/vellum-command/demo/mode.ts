/**
 * Demo/scripting engine flag gate. The engine exists ONLY when the app is
 * launched with --vellum-demo (argv) or VELLUM_COMMAND_DEMO=1 (env) — see
 * src/shared/demo.ts. Cached once: argv/env do not change mid-process.
 */

let cached: boolean | undefined;

export const isDemoMode = (): boolean => {
  if (cached === undefined) {
    cached = process.argv.includes("--vellum-demo") || process.env.VELLUM_COMMAND_DEMO === "1";
  }
  return cached;
};
