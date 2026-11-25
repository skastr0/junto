/**
 * Crashpad from the first moment of main: a local minidump for every process
 * Junto starts afterwards, and never an upload.
 *
 * WHY. 0.11.8 died of a V8 out-of-memory after 29.5 h and left nothing a
 * person could read without the macOS report and a symbol lookup (task #650).
 * A minidump names the frames on any platform, for main, the core, a terminal
 * and every renderer, and it stays on this machine.
 *
 * WHEN. `crashReporter.start` must run before the first window, core, terminal
 * or renderer is created; the handler it starts covers every process created
 * after it. Main calls this before `app.whenReady`, after the userData path is
 * final, because Electron keeps the dumps under it
 * (`app.getPath("crashDumps")`).
 *
 * LOCAL ONLY. `uploadToServer: false` with no `submitURL`: dumps are written,
 * not sent. Junto has no crash server, so nothing leaves the machine.
 *
 * FAIL OPEN. A crash reporter that cannot start is a lost receipt, never a
 * lost boot: the failure is one warn row and the app continues.
 */

/** The subset of Electron's `CrashReporterStartOptions` this app sets. */
export type CrashReporterStartOptions = {
  readonly uploadToServer: boolean;
  readonly compress?: boolean;
  /** Keys at most 39 bytes, values at most 127 bytes; main-process crashes only. */
  readonly extra?: Record<string, string>;
};

/**
 * Local-only options. `compress` is off because gzip only serves uploads, and
 * an uncompressed dump is one `minidump_dump` away from readable on this Mac.
 */
export const crashReporterOptions = (version: string): CrashReporterStartOptions => ({
  uploadToServer: false,
  compress: false,
  extra: { juntoVersion: version },
});

export type CrashReporterDeps = {
  /** Electron's `crashReporter.start`; injected so this module is testable off Electron. */
  readonly start: (options: CrashReporterStartOptions) => void;
  /** `app.getPath("crashDumps")`: read after start, when the handler owns it. */
  readonly crashDumps: () => string;
  readonly version: string;
  readonly write: (level: "info" | "warn", message: string) => void;
};

export type CrashReporterBoot = {
  /** Where dumps will land, or `undefined` when the reporter did not start. */
  readonly crashDumps: string | undefined;
};

/** Start Crashpad once; never throws. */
export const startCrashReporter = (deps: CrashReporterDeps): CrashReporterBoot => {
  try {
    deps.start(crashReporterOptions(deps.version));
  } catch (cause) {
    deps.write("warn", `[crash] crash reporter did not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    return { crashDumps: undefined };
  }
  let crashDumps: string | undefined;
  try {
    crashDumps = deps.crashDumps();
    deps.write("info", `[crash] local minidumps land in ${crashDumps}`);
  } catch (cause) {
    // Started is the part that matters; the path is for a reader.
    deps.write("warn", `[crash] crash reporter started but its dump path is unreadable: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return { crashDumps };
};
