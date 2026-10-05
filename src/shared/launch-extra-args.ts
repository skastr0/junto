/**
 * Operator-authored launch arguments for a managed seat.
 *
 * The picker dials (model, effort, mode, permission) cover what every harness
 * shares. Everything else a harness accepts at start is the operator's to
 * choose: these are the extra argv tokens they typed, stored verbatim on the
 * seat's launch (`ether.terminal.launch.extraArgs`) and appended to every
 * spawn and resume of that seat.
 *
 * Junto keeps exactly one thing for itself: the flags a template already owns
 * (session pin and resume, doctrine carriers, the dials above). An extra
 * argument that names one of those would fight the launch the seat depends on,
 * so it is refused here, with a reason the surface can show.
 */
import { templateFor, type HarnessId } from "./managed-terminal-templates";

/** Longest extra-argument list a seat may carry. */
export const EXTRA_ARGS_MAX = 64;
/** Longest single extra argument. */
export const EXTRA_ARG_MAX_LENGTH = 4000;

export type RejectedExtraArg = {
  readonly token: string;
  readonly reason: string;
};

export type SanitizedExtraArgs = {
  readonly args: readonly string[];
  readonly rejected: readonly RejectedExtraArg[];
};

/** Id-less "continue the latest session" spellings. Never a seat launch. */
const LATEST_SESSION_FLAGS: ReadonlySet<string> = new Set([
  "--continue",
  "--resume-last",
  "--last",
]);

/** `--flag=value` → `--flag`; anything else unchanged. */
const flagNameOf = (token: string): string => {
  if (!token.startsWith("-")) return token;
  const eq = token.indexOf("=");
  return eq > 0 ? token.slice(0, eq) : token;
};

/**
 * Flags the template emits itself, keyed to what each one is for. A seat's
 * extra arguments may not repeat them.
 */
export const reservedLaunchFlags = (
  harness: HarnessId,
): ReadonlyMap<string, string> => {
  const spec = templateFor(harness).argvSpec;
  const reserved = new Map<string, string>();
  const reserve = (flag: string | undefined, why: string): void => {
    const name = flag?.trim();
    if (name && name.startsWith("-") && !reserved.has(name)) {
      reserved.set(name, why);
    }
  };
  reserve(spec.modelFlag, "set by the model choice");
  // Codex carries effort as `-c model_reasoning_effort=…`. `-c` is its general
  // config-override flag, so it stays open to the operator.
  if (!spec.effortConfigKey) reserve(spec.effortFlag, "set by the effort choice");
  reserve(spec.modeFlag, "set by the mode choice");
  reserve(spec.permissionModeFlag, "set by the permission mode choice");
  reserve(spec.profileFlag, "set by the profile choice");
  reserve(spec.providerFlag, "set by the provider choice");
  reserve(spec.sessionIdFlag, "Junto pins the seat's session");
  reserve(spec.resumeFlag, "Junto resumes the seat's session");
  for (const flag of spec.prefix) reserve(flag, "always part of this launch");
  for (const flag of spec.hostProbedFlags ?? []) {
    reserve(flag, "always part of this launch");
  }
  return reserved;
};

/**
 * Keep the operator's tokens in order, dropping only what cannot be part of a
 * seat launch. A refused flag takes its value with it (`--model x` drops both).
 */
export const sanitizeExtraArgs = (
  harness: HarnessId,
  input: readonly string[] | undefined,
): SanitizedExtraArgs => {
  if (!input || input.length === 0) return { args: [], rejected: [] };
  const reserved = reservedLaunchFlags(harness);
  const args: string[] = [];
  const rejected: RejectedExtraArg[] = [];
  for (let i = 0; i < input.length; i += 1) {
    const raw = input[i];
    if (typeof raw !== "string") continue;
    const token = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    if (token.length === 0) continue;
    if (token.length > EXTRA_ARG_MAX_LENGTH) {
      rejected.push({ token: `${token.slice(0, 40)}…`, reason: "too long" });
      continue;
    }
    if (token === "--") {
      rejected.push({ token, reason: "ends the options; nothing after it would apply" });
      continue;
    }
    const name = flagNameOf(token);
    if (LATEST_SESSION_FLAGS.has(name)) {
      rejected.push({ token, reason: "a seat always resumes its own session" });
      continue;
    }
    const why = reserved.get(name);
    if (why !== undefined) {
      rejected.push({ token, reason: why });
      const next = input[i + 1];
      // Separate-value form: the value belongs to the refused flag.
      if (name === token && typeof next === "string" && !next.trim().startsWith("-")) {
        i += 1;
      }
      continue;
    }
    if (args.length >= EXTRA_ARGS_MAX) {
      rejected.push({ token, reason: `more than ${EXTRA_ARGS_MAX} arguments` });
      continue;
    }
    args.push(token);
  }
  return { args, rejected };
};

/**
 * Split a typed argument line into argv tokens. Single and double quotes group
 * words; a backslash escapes the next character outside single quotes. No
 * expansion of any kind: what is typed is what the harness receives.
 */
export const parseExtraArgsText = (text: string): string[] => {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let open = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote !== undefined) {
      if (ch === quote) {
        quote = undefined;
      } else if (ch === "\\" && quote === '"' && i + 1 < text.length) {
        i += 1;
        current += text[i];
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      open = true;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      i += 1;
      current += text[i];
      open = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (open || current.length > 0) out.push(current);
      current = "";
      open = false;
      continue;
    }
    current += ch;
  }
  if (open || current.length > 0) out.push(current);
  return out;
};

/** Inverse of `parseExtraArgsText`: one editable line. */
export const formatExtraArgs = (args: readonly string[] | undefined): string =>
  (args ?? [])
    .map((arg) =>
      arg.length > 0 && !/[\s"'\\]/.test(arg)
        ? arg
        : `"${arg.replace(/(["\\])/g, "\\$1")}"`,
    )
    .join(" ");

/**
 * `argv` with the seat's own extra arguments removed, so template-owned flags
 * are read back from the part of the launch the template wrote. Without this
 * an operator `-c key=value` on Codex would shadow the effort override.
 */
export const argvWithoutExtraArgs = (
  argv: readonly string[],
  extraArgs: readonly string[] | undefined,
): readonly string[] => {
  if (!extraArgs || extraArgs.length === 0) return argv;
  for (let start = argv.length - extraArgs.length; start >= 0; start -= 1) {
    let match = true;
    for (let j = 0; j < extraArgs.length; j += 1) {
      if (argv[start + j] !== extraArgs[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return [...argv.slice(0, start), ...argv.slice(start + extraArgs.length)];
    }
  }
  return argv;
};

// ── Flags a harness reports about itself ───────────────────────────────────

export type HarnessHelpFlag = {
  /** Preferred spelling: the long form when the help line lists one. */
  readonly flag: string;
  /** Other spellings on the same help line (`-m` beside `--model`). */
  readonly aliases: readonly string[];
  /** Value placeholder as printed (`<MODE>`, `LEVEL`); absent for a switch. */
  readonly value?: string;
  readonly description: string;
};

const FLAG_TOKEN = /^-{1,2}[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Read option lines out of a harness's `--help`. Format-tolerant on purpose:
 * clap, commander, argparse and hand-written help all indent an option, list
 * its spellings, then a placeholder and a description on the same or the next
 * indented lines. Anything that does not look like that is skipped.
 */
export const parseHelpFlags = (helpText: string): HarnessHelpFlag[] => {
  const lines = helpText.replace(/\u001b\[[0-9;]*m/g, "").split(/\r?\n/);
  const flags: HarnessHelpFlag[] = [];
  const seen = new Set<string>();
  let current:
    | { flag: string; aliases: string[]; value?: string; description: string[]; indent: number }
    | undefined;
  const flush = (): void => {
    if (!current) return;
    if (!seen.has(current.flag)) {
      seen.add(current.flag);
      flags.push({
        flag: current.flag,
        aliases: current.aliases,
        ...(current.value ? { value: current.value } : {}),
        description: current.description.join(" ").replace(/\s+/g, " ").trim(),
      });
    }
    current = undefined;
  };
  for (const line of lines) {
    const match = line.match(/^(\s+)(-{1,2}[A-Za-z0-9][^\s,]*(?:,\s*-{1,2}[A-Za-z0-9][^\s,]*)*)(.*)$/);
    if (match) {
      flush();
      const indent = match[1]!.length;
      const names: string[] = [];
      let value: string | undefined;
      for (const part of match[2]!.split(/,\s*/)) {
        const eq = part.indexOf("=");
        const name = eq > 0 ? part.slice(0, eq) : part;
        if (eq > 0 && value === undefined) value = part.slice(eq + 1);
        if (FLAG_TOKEN.test(name)) names.push(name);
      }
      if (names.length === 0) continue;
      let rest = match[3]!;
      // A placeholder directly after the names: `<MODE>`, `[id]`, `LEVEL`.
      const placeholder = rest.match(/^[ =]((?:<[^>]+>|\[[^\]]+\]|[A-Z][A-Z0-9_|.]*)(?:\.\.\.)?)(?=\s|$)/);
      if (placeholder) {
        value = value ?? placeholder[1];
        rest = rest.slice(placeholder[0].length);
      }
      const long = names.find((name) => name.startsWith("--")) ?? names[0]!;
      current = {
        flag: long,
        aliases: names.filter((name) => name !== long),
        ...(value ? { value } : {}),
        description: rest.trim() ? [rest.trim()] : [],
        indent,
      };
      continue;
    }
    if (current && line.trim().length > 0 && line.search(/\S/) > current.indent) {
      current.description.push(line.trim());
      continue;
    }
    if (line.trim().length === 0 && current && current.description.length === 0) {
      // clap long help: blank line never separates names from their text.
      continue;
    }
    flush();
  }
  flush();
  return flags;
};
