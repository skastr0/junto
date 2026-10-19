import { delimiter, join } from "node:path";

// Well-known install roots, in priority order. This is the guaranteed floor:
// under a packaged/launchd/Finder launch the process inherits launchd's
// minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin). Bare CLI names
// (hermes/codex/bun) would ENOENT, so these dirs resolve the common roots.
// Real binary dirs rank ahead of shim dirs: a mise/asdf/pyenv shim only works
// inside an activated context, so a genuine binary must win whenever both
// exist.
export const staticPathDirs = (home: string): ReadonlyArray<string> => [
  join(home, ".local", "bin"),
  join(home, ".kimi-code", "bin"),
  join(home, ".bun", "bin"),
  join(home, ".grok", "bin"),
  join(home, ".volta", "bin"),
  join(home, ".cargo", "bin"),
  join(home, ".deno", "bin"),
  join(home, "go", "bin"),
  join(home, "bin"),
  join(home, ".local", "share", "pnpm"),
  join(home, "Library", "pnpm"),
  join(home, ".nix-profile", "bin"),
  join(home, ".local", "share", "mise", "shims"),
  join(home, ".asdf", "shims"),
  join(home, ".pyenv", "shims"),
  join(home, ".rbenv", "shims"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

/** PATH entries in order, trimmed, empties dropped. */
export const pathDirs = (value: string | undefined): ReadonlyArray<string> =>
  (value ?? "").split(delimiter).map((dir) => dir.trim()).filter((dir) => dir.length > 0);

// Pure PATH merge, extracted so the ordering/dedup contract is unit-testable.
// Precedence: the operator's shell PATH, then the PATH Junto inherited, then
// operator tool dirs, then the static floor. First occurrence of each
// directory wins; empty entries are dropped.
export const mergePath = (inputs: {
  readonly shellPath?: string;
  readonly currentPath?: string;
  readonly home: string;
  readonly extraDirs?: ReadonlyArray<string>;
}): string => {
  const segments = [
    ...pathDirs(inputs.shellPath),
    ...pathDirs(inputs.currentPath),
    ...(inputs.extraDirs ?? []).map((dir) => dir.trim()).filter((dir) => dir.length > 0),
    ...staticPathDirs(inputs.home),
  ];
  return [...new Set(segments)].join(delimiter);
};
