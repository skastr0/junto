/**
 * A paired phone found Junto not running: start the installed app and give
 * its operator socket a moment to come up.
 *
 * Only the canonical /Applications/Junto.app, a real bundle, is ever started,
 * and only when this command talks to the socket that app serves: the
 * account's real home with no JUNTO_HOME. A development run, a preview (built
 * under ~/.junto-preview-builds) or a Junto with its own home is never started
 * from here. The bundle identifier is read from that same bundle, so it only
 * guards against another app at that path; it verifies nothing. What plutil
 * prints is compared and dropped, never logged or written anywhere: stderr
 * reaches the phone over SSH.
 */

import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { usableJuntoHome } from "../shared/junto-home";
import { PRODUCT_APP_BUNDLE_NAME, PRODUCT_NAME } from "../shared/product-name";

export const INSTALLED_APP_PATH = `/Applications/${PRODUCT_APP_BUNDLE_NAME}`;
export const INSTALLED_BUNDLE_IDENTIFIER = "com.skastr0.junto";
/** The longest a phone's hello waits for a just-launched app. */
export const COMPANION_LAUNCH_WAIT_MS = 20_000;
export const COMPANION_LAUNCH_POLL_MS = 500;

export interface InstalledAppFacts {
  readonly platform: NodeJS.Platform;
  /** JUNTO_HOME as this process sees it. */
  readonly juntoHome: string | undefined;
  /** HOME as this process sees it. */
  readonly home: string;
  /** The account's home from the user database, whatever HOME says. */
  readonly accountHome: string;
  readonly bundleIsDirectory: boolean;
  readonly executableIsFile: boolean;
  readonly bundleIdentifier: string | undefined;
}

/** Why the installed app may not be started, or undefined when it may. */
export const installedAppRefusal = (facts: InstalledAppFacts): string | undefined => {
  if (facts.platform !== "darwin") return "not macOS";
  if (usableJuntoHome(facts.juntoHome) !== undefined) return "JUNTO_HOME names another home";
  if (resolve(facts.home) !== resolve(facts.accountHome)) return "HOME is not the account's home";
  if (!facts.bundleIsDirectory || !facts.executableIsFile) return `${INSTALLED_APP_PATH} is not installed`;
  if (facts.bundleIdentifier !== INSTALLED_BUNDLE_IDENTIFIER) return `${INSTALLED_APP_PATH} is not Junto`;
  return undefined;
};

/** The SSH session's environment (LANG, LC_* and whatever sshd accepts) never reaches a child. */
const CHILD_ENV = { PATH: "/usr/bin:/bin" };

const run = (file: string, args: ReadonlyArray<string>, timeoutMs: number): Promise<string | undefined> =>
  new Promise((done) => {
    execFile(file, [...args], { timeout: timeoutMs, maxBuffer: 64 * 1024, env: CHILD_ENV }, (error, stdout) => {
      done(error ? undefined : stdout.trim());
    });
  });

const isReal = (path: string, kind: "directory" | "file"): boolean => {
  try {
    const stat = lstatSync(path);
    return !stat.isSymbolicLink() && (kind === "directory" ? stat.isDirectory() : stat.isFile());
  } catch {
    return false;
  }
};

const readInstalledAppFacts = async (): Promise<InstalledAppFacts> => {
  const base = {
    platform: process.platform,
    juntoHome: process.env.JUNTO_HOME,
    home: homedir(),
    accountHome: userInfo().homedir,
    bundleIsDirectory: isReal(INSTALLED_APP_PATH, "directory"),
    executableIsFile: isReal(join(INSTALLED_APP_PATH, "Contents", "MacOS", PRODUCT_NAME), "file"),
  };
  const bundleIdentifier = base.platform === "darwin" && base.bundleIsDirectory
    ? await run(
        "/usr/bin/plutil",
        ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(INSTALLED_APP_PATH, "Contents", "Info.plist")],
        2_000,
      )
    : undefined;
  return { ...base, bundleIdentifier };
};

/**
 * Start the installed Junto in the background (`open -g`, so it takes no
 * focus). True when the launch was handed to macOS; false when it was refused
 * or failed, and then nothing was started.
 */
export const launchInstalledJunto = async (): Promise<boolean> => {
  const refusal = installedAppRefusal(await readInstalledAppFacts());
  if (refusal !== undefined) return false;
  return (await run("/usr/bin/open", ["-g", INSTALLED_APP_PATH], 5_000)) !== undefined;
};
