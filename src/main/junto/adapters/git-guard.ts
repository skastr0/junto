/**
 * A folder's own git config can name commands that git runs on a plain read:
 * `core.fsmonitor` runs on `status`, `diff` and `ls-files`; a filter driver
 * (`filter.<name>.clean`, `.smudge`, `.process`, picked by `.gitattributes`)
 * runs on `status` and on a diff against the work tree; `log.showSignature`
 * runs `gpg.program`. A downloaded folder with its `.git`, or anything a
 * seat writes, would get code run by Junto when the operator opens it.
 * Every git main runs passes these overrides (`-c` reaches child gits too,
 * through GIT_CONFIG_PARAMETERS). Diffs also pass `--no-ext-diff` and
 * `--no-textconv` where they are built (`git.ts`).
 */

/** Overrides for every git main runs: nothing named by repository config runs. */
export const GIT_GUARD_ARGS: ReadonlyArray<string> = [
  "-c", "core.fsmonitor=false",
  "-c", "core.hooksPath=/dev/null",
  "-c", "log.showSignature=false",
  // Never look inside a submodule's work tree, whose config is not read here.
  "-c", "diff.ignoreSubmodules=dirty",
];

/** The command that lists a repository's filter drivers; reading config runs nothing. */
export const GIT_FILTER_CONFIG_ARGS: ReadonlyArray<string> = [
  ...GIT_GUARD_ARGS,
  "config", "-z", "--get-regexp", "^filter\\.",
];

/**
 * Driver names in `git config -z --get-regexp` output (`key\nvalue\0` per
 * entry). A name may hold dots: it is everything between `filter.` and the
 * last dot.
 */
export const filterDriverNames = (output: string): ReadonlyArray<string> => {
  const names = new Set<string>();
  for (const entry of output.split("\0")) {
    const key = entry.split("\n", 1)[0] ?? "";
    if (!key.startsWith("filter.")) continue;
    const last = key.lastIndexOf(".");
    if (last <= "filter.".length) continue;
    names.add(key.slice("filter.".length, last));
  }
  return [...names];
};

/**
 * A driver `-c` cannot reach: `-c` splits at the first `=`, so
 * `filter.x=y.clean=` sets nothing on driver `x=y`. Git is not run at all
 * in a repository that names one.
 */
export const unguardableDrivers = (names: ReadonlyArray<string>): boolean =>
  names.some((name) => name.includes("="));

export const UNGUARDABLE_GIT_ERROR =
  "this repository's config names a filter driver Junto cannot switch off, so Junto does not run git in it";

/** Empty every command a driver names; git skips a filter whose command is empty. */
export const filterGuardArgs = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.flatMap((name) => [
    "-c", `filter.${name}.clean=`,
    "-c", `filter.${name}.smudge=`,
    "-c", `filter.${name}.process=`,
    "-c", `filter.${name}.required=false`,
  ]);
