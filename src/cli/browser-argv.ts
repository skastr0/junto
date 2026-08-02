/**
 * Pure argv helper — no @effect/platform-bun import so vitest (Node) can load
 * it without resolving Bun-only modules (e.g. BunRedis → package "bun").
 */
export const browserCliArgsFromArgv = (
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  const sourceEntrypoint = argv[1]?.replaceAll("\\", "/");
  const commandIndex =
    sourceEntrypoint?.endsWith("/src/cli/main.ts") === true ? 2 : 1;
  return argv[commandIndex] === "browser"
    ? argv.slice(commandIndex + 1)
    : undefined;
};
