import type {
  ShellEnvironmentChange,
  ShellEnvironmentFailure,
  ShellEnvironmentStatus,
} from "@shared/shell-environment";
import type { ToolRunner } from "../region-env/tool";
import { mergePath, pathDirs } from "./path";
import { probeShellEnvironment, SHELL_ENVIRONMENT_TIMEOUT_MS } from "./probe";

/** Main's view adds the moment before the first read; the wire never carries it. */
export type ShellEnvironmentState = ShellEnvironmentStatus | { readonly _tag: "Unresolved" };

export type ShellEnvironmentDeps = {
  readonly runTool: ToolRunner;
  /** The environment seats inherit: process.env in the product. */
  readonly target: NodeJS.ProcessEnv;
  readonly home: () => string;
  readonly now: () => number;
  /** The login shell to read, from the environment Junto launched with. */
  readonly shell: (launched: NodeJS.ProcessEnv) => string | undefined;
  /** JUNTO_SHELL_ENVIRONMENT=inherit. */
  readonly turnedOff: (launched: NodeJS.ProcessEnv) => boolean;
  /** App-owned directory the shell starts in, never the operator home. */
  readonly cwd: () => Promise<string>;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  readonly warn?: (line: string) => void;
};

type Good = {
  readonly shell: string;
  readonly resolvedAt: number;
  readonly durationMs: number;
  readonly generation: number;
  /** Everything the shell exported that Junto takes, PATH included. */
  readonly variables: Readonly<Record<string, string>>;
};

type Failure = { readonly shell?: string; readonly at: number; readonly cause: ShellEnvironmentFailure };

/** Names of variables that differ, never their values. */
export const diffVariableNames = (
  before: Readonly<Record<string, string | undefined>>,
  after: Readonly<Record<string, string | undefined>>,
): Pick<ShellEnvironmentChange, "added" | "removed" | "changed"> => {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [name, value] of Object.entries(after)) {
    if (value === undefined) continue;
    const old = before[name];
    if (old === undefined) added.push(name);
    else if (old !== value) changed.push(name);
  }
  for (const [name, value] of Object.entries(before)) {
    if (value !== undefined && after[name] === undefined) removed.push(name);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
};

const withoutPath = (variables: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => {
  const { PATH: _path, ...rest } = variables;
  return rest;
};

/**
 * The operator's shell environment: read once per app start, read again on
 * request, and applied to the environment every spawn inherits.
 */
export const makeShellEnvironment = (deps: ShellEnvironmentDeps) => {
  // What Junto launched with, taken as the first read starts, before anything
  // changes it. Every read starts from it, so an export the operator removed
  // goes away.
  let launched: NodeJS.ProcessEnv | undefined;
  let good: Good | undefined;
  let failure: Failure | undefined;
  let turnedOff = false;
  let generation = 0;
  let settled = false;
  let flight: { readonly since: number; readonly done: Promise<void> } | undefined;
  let toolDirs: ReadonlyArray<string> = [];
  let current: NodeJS.ProcessEnv | undefined;
  const listeners = new Set<(change: ShellEnvironmentChange) => void>();

  const launchedEnvironment = (): NodeJS.ProcessEnv => launched ?? deps.target;

  const pathFor = (shellPath: string | undefined): string =>
    mergePath({
      ...(shellPath === undefined ? {} : { shellPath }),
      currentPath: launchedEnvironment().PATH,
      home: deps.home(),
      extraDirs: toolDirs,
    });

  /** The whole environment seats would get from `variables`, PATH merged. */
  const effective = (variables: Readonly<Record<string, string>> | undefined): Record<string, string | undefined> => ({
    ...launchedEnvironment(),
    ...(variables ? withoutPath(variables) : {}),
    PATH: pathFor(variables?.PATH),
  });

  const publish = (): void => {
    const path = pathFor(good?.variables.PATH);
    deps.target.PATH = path;
    current = { ...deps.target, PATH: path };
  };

  // One synchronous step: a spawn sees the old environment or the new one,
  // never a mix.
  const swap = (next: Good): void => {
    const base = launchedEnvironment();
    const names = new Set([...Object.keys(withoutPath(good?.variables ?? {})), ...Object.keys(withoutPath(next.variables))]);
    for (const name of names) {
      const value = name in next.variables ? next.variables[name] : base[name];
      if (value === undefined) delete deps.target[name];
      else deps.target[name] = value;
    }
    good = next;
    publish();
  };

  const causeOf = (shell: string | undefined, cause: ShellEnvironmentFailure): void => {
    failure = { ...(shell === undefined ? {} : { shell }), at: deps.now(), cause };
    deps.warn?.(
      `[env] ${shell ?? "no shell"} gave no environment (${cause._tag}); seats use ${good ? "the previous environment" : "the inherited PATH and the floor"}`,
    );
  };

  const read = async (reason: string): Promise<void> => {
    const base = launchedEnvironment();
    if (deps.turnedOff(base)) {
      turnedOff = true;
      return;
    }
    const shell = deps.shell(base);
    if (shell === undefined) {
      causeOf(undefined, { _tag: "NoShell" });
      return;
    }
    const startedAt = deps.now();
    const result = await probeShellEnvironment(deps.runTool, {
      shell,
      cwd: await deps.cwd(),
      env: base,
      timeoutMs: deps.timeoutMs ?? SHELL_ENVIRONMENT_TIMEOUT_MS,
    });
    if (!result.ok) {
      causeOf(shell, result.cause);
      return;
    }
    const resolvedAt = deps.now();
    const before = effective(good?.variables);
    const after = effective(result.environment);
    const names = diffVariableNames(withoutPath(before), withoutPath(after));
    const beforeDirs = new Set(pathDirs(before.PATH));
    const afterDirs = pathDirs(after.PATH);
    const pathAdded = afterDirs.filter((dir) => !beforeDirs.has(dir));
    const pathRemoved = [...beforeDirs].filter((dir) => !afterDirs.includes(dir));
    const changed = good === undefined
      || names.added.length + names.removed.length + names.changed.length + pathAdded.length + pathRemoved.length > 0;
    // An identical read keeps its generation: seats started on it are current.
    if (changed) generation += 1;
    failure = undefined;
    swap({
      shell,
      resolvedAt,
      durationMs: Math.max(0, resolvedAt - startedAt),
      generation,
      variables: result.environment,
    });
    deps.log?.(
      `[env] ${shell} gave its environment in ${Math.max(0, resolvedAt - startedAt)}ms (${Object.keys(result.environment).length} variables, generation ${generation}, ${reason})`,
    );
    if (!changed) return;
    const change: ShellEnvironmentChange = { generation, ...names, pathAdded, pathRemoved };
    for (const listener of [...listeners]) {
      try {
        listener(change);
      } catch (cause) {
        deps.warn?.(`[env] a change listener failed: ${cause instanceof Error ? cause.name : "error"}`);
      }
    }
  };

  const start = (reason: string): Promise<void> => {
    if (flight) return flight.done;
    launched ??= { ...deps.target };
    const done = read(reason)
      .catch((cause: unknown) => {
        causeOf(undefined, { _tag: "SpawnFailed" });
        deps.warn?.(`[env] the read stopped unexpectedly: ${cause instanceof Error ? cause.name : "error"}`);
      })
      .finally(() => {
        settled = true;
        if (flight?.done === done) flight = undefined;
        if (!current) publish();
      });
    flight = { since: deps.now(), done };
    return done;
  };

  const state = (): ShellEnvironmentState => {
    if (!settled) return { _tag: "Unresolved" };
    if (flight) return { _tag: "Resolving", since: flight.since, generation };
    if (turnedOff) return { _tag: "Inherited" };
    if (failure) {
      return {
        _tag: "Failed",
        ...(failure.shell === undefined ? {} : { shell: failure.shell }),
        at: failure.at,
        cause: failure.cause,
        generation,
        usingPrevious: good !== undefined,
      };
    }
    if (!good) return { _tag: "Inherited" };
    const inherited = new Set(pathDirs(launchedEnvironment().PATH));
    return {
      _tag: "Resolved",
      shell: good.shell,
      resolvedAt: good.resolvedAt,
      durationMs: good.durationMs,
      variableCount: Object.keys(good.variables).length,
      generation: good.generation,
      pathAdded: pathDirs(good.variables.PATH).filter((dir) => !inherited.has(dir)),
    };
  };

  /** Resolved once per app start; concurrent callers share one read. */
  const ensure = async (): Promise<NodeJS.ProcessEnv> => {
    if (!settled || flight) await start("startup");
    return current ?? environmentNow();
  };

  /** Read again. Seats started after it get the new environment; a failure keeps the old one. */
  const refresh = async (reason: string): Promise<ShellEnvironmentStatus> => {
    await start(reason);
    return status();
  };

  /** The wire answer: waits for the first read, never for a later refresh. */
  const status = async (): Promise<ShellEnvironmentStatus> => {
    if (!settled) await start("startup");
    const now = state();
    // After a settled first read, Unresolved cannot occur.
    return now._tag === "Unresolved" ? { _tag: "Inherited" } : now;
  };

  /** For call sites that cannot await: the last applied environment, or the floor. */
  const environmentNow = (): NodeJS.ProcessEnv =>
    current ?? { ...deps.target, PATH: pathFor(undefined) };

  const setToolDirectories = (directories: ReadonlyArray<string>): void => {
    toolDirs = directories;
    if (current) publish();
  };

  const onChange = (listener: (change: ShellEnvironmentChange) => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    ensure,
    refresh,
    status,
    state,
    onChange,
    environmentNow,
    setToolDirectories,
    toolDirectories: (): ReadonlyArray<string> => toolDirs,
    /** Epoch ms of the environment in use, for the staleness check. */
    resolvedAt: (): number | undefined => good?.resolvedAt,
    generation: (): number => generation,
  };
};

export type ShellEnvironment = ReturnType<typeof makeShellEnvironment>;
