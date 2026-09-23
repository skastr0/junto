/**
 * The packaged Junto.app under Cua Driver, for the qa:t1 and qa:explore tiers.
 *
 * Each run gets a throwaway root: HOME and JUNTO_HOME point at `<root>/home`
 * and Electron's user data at `<root>/user-data`, so product state, control
 * sockets, and every `~` path stay out of the operator's real home. The app is
 * started through LaunchServices (`open -n`), so macOS attributes any
 * permission prompt to Junto itself, exactly as it would for a user. After
 * that one launch, every observation and action goes through the single
 * persistent driver connection.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { join } from "node:path";
import { CuaDriver, type Json } from "./cua";

export const INSTALLED_APP = "/Applications/Junto.app";

/**
 * The app bundle to test: `release/mac-arm64/Junto.app` when it was built after
 * HEAD was committed, otherwise the installed app, used read-only.
 */
export const resolveTargetApp = (repoRoot: string): { readonly path: string; readonly reason: string } => {
  const release = join(repoRoot, "release/mac-arm64/Junto.app");
  const headTime = Number(
    spawnSync("git", ["log", "-1", "--format=%ct"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim(),
  );
  if (existsSync(release) && statSync(release).mtimeMs / 1000 > headTime) {
    return { path: release, reason: "release/mac-arm64 build is newer than HEAD" };
  }
  return {
    path: INSTALLED_APP,
    reason: existsSync(release) ? "release/mac-arm64 build predates HEAD; using the installed app" : "no release build; using the installed app",
  };
};

export const appVersion = (appPath: string): string =>
  spawnSync("defaults", ["read", join(appPath, "Contents/Info.plist"), "CFBundleShortVersionString"], {
    encoding: "utf8",
  }).stdout.trim();

/** Short /tmp root: control sockets live 35 bytes under HOME and macOS caps them near 104. */
export const makeRoot = (label: string): string => {
  const root = mkdtempSync(`/tmp/junto-qa-${label}-`);
  mkdirSync(join(root, "home"), { recursive: true });
  return root;
};

export interface AxElement {
  readonly element_index: number;
  readonly element_token?: string;
  readonly role: string;
  readonly label?: string;
  readonly value?: unknown;
  readonly depth?: number;
  readonly parent_index?: number;
  readonly enabled?: boolean;
  readonly frame?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

export interface MenuEntry {
  readonly menu: string;
  readonly label: string;
  readonly enabled: boolean;
}

export interface Observation {
  readonly elements: ReadonlyArray<AxElement>;
  /** Visible text of the window's own content: labels and values, menu bar excluded. */
  readonly texts: ReadonlyArray<string>;
  /** The app's own menus (the Apple menu and the system Services submenu excluded). */
  readonly menus: ReadonlyArray<MenuEntry>;
}

interface WindowRecord {
  readonly window_id: number;
  readonly pid: number;
  readonly app_name?: string;
  readonly title?: string;
  readonly is_on_screen?: boolean;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

/**
 * Processes that host macOS consent and security prompts. A new window from
 * one of these that names Junto is a permission prompt Junto caused.
 */
export const PROMPT_HOSTS: ReadonlySet<string> = new Set([
  "UserNotificationCenter",
  "universalAccessAuthWarn",
  "SecurityAgent",
  "CoreServicesUIAgent",
  "tccd",
]);

const findMainPid = (userDataDir: string, appPath: string): number | undefined => {
  const binary = join(appPath, "Contents/MacOS/");
  const lines = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n");
  const line = lines.find((l) => l.includes(binary) && l.includes(`--user-data-dir=${userDataDir}`) && !l.includes("--type="));
  return line ? Number(line.trim().split(/\s+/)[0]) : undefined;
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class PackagedApp {
  private pxRatio: { readonly bounds: string; readonly ratio: number } | undefined;

  private constructor(
    readonly driver: CuaDriver,
    readonly appPath: string,
    readonly root: string,
    readonly pid: number,
    public windowId: number,
    readonly launchMs: number,
  ) {}

  get home(): string {
    return join(this.root, "home");
  }

  /** Launch through LaunchServices into the root's throwaway HOME and wait for the main window. */
  static async launch(driver: CuaDriver, appPath: string, root: string, timeoutMs = 30_000): Promise<PackagedApp> {
    const home = join(root, "home");
    const userData = join(root, "user-data");
    const started = Date.now();
    execFileSync("open", [
      "-n",
      "-g",
      "-a",
      appPath,
      "--env",
      `HOME=${home}`,
      "--env",
      `JUNTO_HOME=${home}`,
      "--args",
      `--user-data-dir=${userData}`,
    ]);
    let pid: number | undefined;
    while (Date.now() - started < timeoutMs) {
      pid ??= findMainPid(userData, appPath);
      if (pid !== undefined) {
        const windows = (await driver.call("list_windows", { pid })).windows as WindowRecord[];
        const main = windows.find((w) => w.is_on_screen && w.bounds.width > 400 && w.bounds.height > 300);
        if (main) return new PackagedApp(driver, appPath, root, pid, main.window_id, Date.now() - started);
      }
      await Bun.sleep(250);
    }
    if (pid !== undefined) throw new LaunchError(`no main window within ${timeoutMs}ms`, pid);
    throw new LaunchError(`no process within ${timeoutMs}ms`);
  }

  alive(): boolean {
    return alive(this.pid);
  }

  async windows(): Promise<WindowRecord[]> {
    return (await this.driver.call("list_windows", { pid: this.pid })).windows as WindowRecord[];
  }

  async observe(windowId = this.windowId): Promise<Observation> {
    const state = await this.driver.call("get_window_state", {
      pid: this.pid,
      window_id: windowId,
      include_screenshot: false,
      max_elements: 2_000,
    });
    const elements = (state.elements as AxElement[] | undefined) ?? [];
    const byIndex = new Map(elements.map((e) => [e.element_index, e] as const));
    const menuOf = (element: AxElement): string | undefined => {
      let cursor: AxElement | undefined = element;
      const chain: AxElement[] = [];
      while (cursor) {
        chain.push(cursor);
        if (cursor.role === "AXMenuBarItem") break;
        cursor = cursor.parent_index === undefined ? undefined : byIndex.get(cursor.parent_index);
      }
      const top = chain.at(-1);
      if (top?.role !== "AXMenuBarItem") return undefined;
      // Services lists other apps' actions; it is the system's, not Junto's.
      if (chain.some((e) => e.role === "AXMenuItem" && e.label === "Services" && e !== element)) return undefined;
      return top.label;
    };
    const menus: MenuEntry[] = [];
    const texts: string[] = [];
    for (const element of elements) {
      const menu = menuOf(element);
      if (menu !== undefined) {
        if (menu !== "Apple" && element.role === "AXMenuItem" && element.label) {
          menus.push({ menu, label: element.label, enabled: element.enabled !== false });
        }
        continue;
      }
      if (element.role === "AXMenuBar" || element.role === "AXMenuBarItem" || element.role === "AXMenu") continue;
      for (const part of [element.label, typeof element.value === "string" ? element.value : undefined]) {
        if (part && part.trim() !== "") texts.push(part);
      }
    }
    return { elements, texts, menus };
  }

  /** Window-local screenshot pixels per screen point, from a capture-only read. */
  private async ratio(): Promise<number> {
    const windows = await this.windows();
    const main = windows.find((w) => w.window_id === this.windowId);
    const key = JSON.stringify(main?.bounds ?? null);
    if (this.pxRatio?.bounds === key) return this.pxRatio.ratio;
    const capture = await this.driver.call("get_window_state", {
      pid: this.pid,
      window_id: this.windowId,
      include_accessibility_tree: false,
    });
    const bounds = capture.window_bounds as { width: number };
    const ratio = Number(capture.screenshot_width) / bounds.width;
    this.pxRatio = { bounds: key, ratio };
    return ratio;
  }

  /**
   * A real pointer click at the centre of an AX element's frame. React Flow
   * listens to pointer events, which an AX press does not fire, so this uses
   * foreground delivery: the driver fronts the window, clicks, and restores
   * the previous frontmost app.
   */
  async pointerClick(element: AxElement, count: 1 | 2 = 1): Promise<Json> {
    if (!element.frame) throw new Error(`element ${element.label ?? element.role} has no frame`);
    const windows = await this.windows();
    const main = windows.find((w) => w.window_id === this.windowId);
    if (!main) throw new Error("main window is gone");
    const ratio = await this.ratio();
    const x = Math.round((element.frame.x + element.frame.w / 2 - main.bounds.x) * ratio);
    const y = Math.round((element.frame.y + element.frame.h / 2 - main.bounds.y) * ratio);
    const args = { pid: this.pid, window_id: this.windowId, x, y, delivery_mode: "foreground" };
    return count === 2 ? this.driver.call("double_click", args) : this.driver.call("click", args);
  }

  /** AX press through a fresh element token (buttons). */
  press(element: AxElement): Promise<Json> {
    if (!element.element_token) throw new Error(`element ${element.label ?? element.role} has no token`);
    return this.driver.call("click", { element_token: element.element_token, pid: this.pid });
  }

  invokeMenu(path: ReadonlyArray<string>): Promise<Json> {
    return this.driver.call("invoke_menu", { pid: this.pid, window_id: this.windowId, path });
  }

  pressEscape(): Promise<Json> {
    return this.driver.call("press_key", { pid: this.pid, window_id: this.windowId, key: "escape", delivery_mode: "foreground" });
  }

  /**
   * Quit through the app menu. `delivered` is false when the driver could not
   * reach the menu (a focus fight with another app, not a Junto defect); the
   * app then gets SIGTERM, the same request macOS sends on logout. A delivered
   * quit that does not exit is killed and reported as not clean.
   */
  async quit(timeoutMs = 10_000): Promise<{ readonly clean: boolean; readonly delivered: boolean; readonly ms: number; readonly detail: string }> {
    const started = Date.now();
    const { menus } = await this.observe().catch(() => ({ menus: [] as MenuEntry[] }));
    const quit = menus.find((entry) => /^Quit\b/.test(entry.label) && !/Keep Windows/.test(entry.label));
    let detail = quit ? `${quit.menu} > ${quit.label}` : "no Quit item";
    let delivered = quit !== undefined;
    if (quit) {
      await this.invokeMenu([quit.menu, quit.label]).catch((error: Error) => {
        delivered = false;
        detail += `; not delivered: ${error.message}`;
      });
    }
    if (!delivered && this.alive()) process.kill(this.pid, "SIGTERM");
    while (Date.now() - started < timeoutMs) {
      if (!this.alive()) return { clean: true, delivered, ms: Date.now() - started, detail };
      await Bun.sleep(200);
    }
    await this.driver.call("kill_app", { pid: this.pid }).catch(() => {});
    return { clean: false, delivered, ms: Date.now() - started, detail };
  }

  /** Windows other processes opened since `before` that are Junto-attributed consent prompts. */
  async promptsSince(before: ReadonlySet<number>): Promise<Array<{ readonly app: string; readonly title: string; readonly text: string }>> {
    const all = (await this.driver.call("list_windows", {})).windows as WindowRecord[];
    const prompts: Array<{ app: string; title: string; text: string }> = [];
    for (const window of all) {
      if (before.has(window.window_id) || window.pid === this.pid) continue;
      if (!PROMPT_HOSTS.has(window.app_name ?? "")) continue;
      let text = window.title ?? "";
      try {
        const state = await this.driver.call("get_window_state", {
          pid: window.pid,
          window_id: window.window_id,
          include_screenshot: false,
          max_elements: 200,
        });
        text = ((state.elements as AxElement[] | undefined) ?? [])
          .map((e) => [e.label, typeof e.value === "string" ? e.value : ""].join(" "))
          .join(" ");
      } catch {
        // an unreadable prompt still counts through its title
      }
      if (/junto/i.test(`${window.title ?? ""} ${text}`)) {
        prompts.push({ app: window.app_name ?? "", title: window.title ?? "", text: text.replace(/\s+/g, " ").slice(0, 400) });
      }
    }
    return prompts;
  }
}

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly pid?: number,
  ) {
    super(message);
  }
}

/** Every window id on the desktop now, so later prompts can be told apart. */
export const windowIds = async (driver: CuaDriver): Promise<Set<number>> =>
  new Set(((await driver.call("list_windows", {})).windows as WindowRecord[]).map((w) => w.window_id));

/** Seed the registry scene into `<root>/home` through the harness fixture writer (node-only). */
export const seedScene = (repoRoot: string, root: string): void => {
  const result = spawnSync(join(repoRoot, "scripts/run-e2e.sh"), ["e2e/qa/seed.spec.ts"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, JUNTO_E2E_CONFIG: "e2e/qa/playwright.config.ts", QA_SEED_HOME: join(root, "home") },
  });
  if (result.status !== 0 || !existsSync(join(root, "home/.junto/state/junto.db"))) {
    throw new Error(`seeding the qa scene failed: ${(result.stdout + result.stderr).slice(-800)}`);
  }
};
