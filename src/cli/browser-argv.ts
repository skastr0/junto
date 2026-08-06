/**
 * Pure argv helper — no @effect/platform-bun import so vitest (Node) can load
 * it without resolving Bun-only modules (e.g. BunRedis → package "bun").
 *
 * Bun places user args at index 2 in both execution modes:
 *   source   = [bunPath, "/…/src/cli/main.ts", ...args]
 *   compiled = ["bun", "/$bunfs/root/vellum-command", ...args]
 * Only the top-level command dispatches Browser; a later `browser` value
 * (for example `--capability browser`) remains CLI data.
 */
export const browserCliArgsFromArgv = (
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined =>
  argv[2] === "browser" ? argv.slice(3) : undefined;
