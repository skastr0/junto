/**
 * The environment a launched test app receives, kept apart from launch.ts so a
 * unit test can build it without Playwright, Electron or a renderer server.
 *
 * The operator's rule is the prefix, not a list: a seat carries JUNTO_HOME,
 * JUNTO_WORK_TOKEN, JUNTO_CLI and any future JUNTO_* variable, and none of them
 * may reach a test app. A fixed list goes stale the day a new variable lands
 * (JUNTO_CLI already had), and a leaked one points the app at the operator's
 * live home or socket.
 */

/** Every inherited key that is not part of the JUNTO_* family. */
export const inheritedEnvForLaunch = (
  inherited: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (key.startsWith("JUNTO_")) continue;
    kept[key] = value;
  }
  return kept;
};

export interface LaunchEnvironmentInput {
  /** This process's environment, the only thing inherited. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** The launch's throwaway home: HOME, and the parent of the state it seeds. */
  readonly home: string;
  /** The launch's sandbox root: TMPDIR, TMP and TEMP, so two workers never share a demo database. */
  readonly tempRoot: string;
  /** The scenario renderer server's loopback URL, as electron-vite supplies it. */
  readonly rendererUrl: string;
  /**
   * The PATH for this launch: e2e/fakes/bin plus the system floor, never the
   * operator's. Not a per-spec choice: app boot unconditionally starts the
   * usage-HUD poller, which probes native sources the moment a window opens,
   * demo or not. A spec's `extraEnv.PATH`, if it sets one, still wins, because
   * extraEnv is applied last.
   */
  readonly path: string;
  /** JUNTO_DEMO=1 for a demo-isolated launch. */
  readonly demo?: boolean;
  /**
   * The sandbox's own bin dirs, colon separated: the harness resolves a seat's
   * binary from here and nowhere else in an E2E run (src/shared/e2e-sandbox.ts).
   * A real install is outside it on purpose, and only a named opt-in reaches it.
   */
  readonly sandboxPath?: string;
  /** A spec's own overrides, applied last, so a spec that sets PATH still wins. */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

/**
 * The whole environment a launched app sees. Nothing from the inherited JUNTO_*
 * family survives, and the harness sets only what it means to: e2e marker, file
 * secret store, demo marker, throwaway home and temp roots, fakes PATH.
 */
export const launchEnvironment = (input: LaunchEnvironmentInput): Record<string, string> => ({
  ...inheritedEnvForLaunch(input.inherited),
  HOME: input.home,
  // Demo isolation mints junto-demo-runtime-* under os.tmpdir(). Pin TMPDIR to
  // this launch's sandbox so two workers cannot seed each other's newest demo
  // database. The demo file is SQLite, not a UDS.
  TMPDIR: input.tempRoot,
  TMP: input.tempRoot,
  TEMP: input.tempRoot,
  SHELL: "/bin/sh",
  JUNTO_E2E: "1",
  // The one inherited JUNTO_ key, by name: an operator asking for visible
  // windows (src/app/e2e-presentation.ts) is asking the harness, not leaking a
  // seat's identity into the app.
  ...(input.inherited.JUNTO_E2E_SHOW === "1" ? { JUNTO_E2E_SHOW: "1" } : {}),
  // Junto's own secrets go to owner-only files under this launch's throwaway
  // home. Never the operator's real Keychain or keyring.
  JUNTO_SECRET_STORE: "file",
  // Match electron-vite's real development contract exactly. It supplies the
  // loopback authority without a trailing slash; a normalized test-only URL
  // here previously hid a black-window startup regression.
  ELECTRON_RENDERER_URL: input.rendererUrl.endsWith("/")
    ? input.rendererUrl.slice(0, -1)
    : input.rendererUrl,
  ...(input.demo === true ? { JUNTO_DEMO: "1" } : {}),
  PATH: input.path,
  ...(input.sandboxPath === undefined ? {} : { JUNTO_E2E_SANDBOX_PATH: input.sandboxPath }),
  ...input.extraEnv,
});
