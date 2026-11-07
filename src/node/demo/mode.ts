/**
 * Demo/scripting engine flag gate. The engine exists ONLY when the app is
 * launched with --junto-demo (argv) or JUNTO_DEMO=1 (env) — see
 * src/shared/demo.ts. Cached once: argv/env do not change mid-process.
 */

let cached: boolean | undefined;

export const isDemoMode = (): boolean => {
  if (cached === undefined) {
    cached = process.argv.includes("--junto-demo") || process.env.JUNTO_DEMO === "1";
  }
  return cached;
};
