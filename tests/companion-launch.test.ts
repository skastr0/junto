/**
 * `junto companion-stdio` starting the installed Junto for a phone.
 *
 * Pins which app may be started (only /Applications/Junto.app with Junto's
 * bundle identifier, only for the account's real home), and that the hello
 * starts it once, waits at most 20 seconds for the socket, and otherwise
 * answers app-not-running as before. Nothing here starts a real app.
 */
import { describe, expect, it, vi } from "vitest";
import {
  COMPANION_LAUNCH_WAIT_MS,
  INSTALLED_BUNDLE_IDENTIFIER,
  installedAppRefusal,
  type InstalledAppFacts,
} from "../src/cli/companion-launch";
import { makeRelayHost, type Wake } from "../src/cli/companion-stdio";

// The real launcher is never reachable from this file; the mock records any call.
const launchInstalledJunto = vi.hoisted(() => vi.fn(async () => true));
vi.mock("../src/cli/companion-launch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cli/companion-launch")>()),
  launchInstalledJunto,
}));

const DEVICE = "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3";
const HELLO = { ok: true, hello: { appVersion: "t", deviceId: DEVICE, deviceName: "Phone", station: "Mac", serverTime: 1 } } as const;

const installed: InstalledAppFacts = {
  platform: "darwin",
  juntoHome: undefined,
  home: "/Users/me",
  accountHome: "/Users/me",
  bundleIsDirectory: true,
  executableIsFile: true,
  bundleIdentifier: INSTALLED_BUNDLE_IDENTIFIER,
};

describe("which app may be started", () => {
  it("starts the canonical installed app for the account's own home", () => {
    expect(installedAppRefusal(installed)).toBeUndefined();
    expect(installedAppRefusal({ ...installed, juntoHome: "  " })).toBeUndefined();
  });

  it.each([
    ["Linux", { platform: "linux" }],
    ["a Junto with its own home", { juntoHome: "/Users/me/.junto-dev" }],
    ["HOME pointed elsewhere", { home: "/tmp/jr-x" }],
    ["no bundle in /Applications", { bundleIsDirectory: false }],
    ["a bundle without its executable", { executableIsFile: false }],
    ["another app under Junto's name", { bundleIdentifier: "com.example.other" }],
    ["an unreadable Info.plist", { bundleIdentifier: undefined }],
  ] as const)("refuses %s", (_label, change) => {
    expect(installedAppRefusal({ ...installed, ...change })).toBeTypeOf("string");
  });
});

/** A fake clock: sleeping advances it, and a test may charge each attempt. */
const clock = (launched: boolean) => {
  let t = 0;
  const wake: Wake & { launches: number } = {
    launches: 0,
    launch: async () => {
      wake.launches += 1;
      return launched;
    },
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
  return { wake, advance: (ms: number) => (t += ms), at: () => t };
};

describe("the hello when the app is not running", () => {
  it("starts nothing when the relay host is built without a wake", async () => {
    const call = vi.fn(async () => ({ ok: false as const, down: true }));
    const result = await makeRelayHost(DEVICE, call as never).hello();
    expect(result).toMatchObject({ ok: false, error: { code: "app-not-running" } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(launchInstalledJunto).not.toHaveBeenCalled();
  });

  it("starts the installed app and says hello once its socket answers", async () => {
    const c = clock(true);
    const call = vi.fn(async () => (c.at() >= 3_000 ? { ok: true as const, data: HELLO } : { ok: false as const, down: true }));
    const result = await makeRelayHost(DEVICE, call as never, c.wake).hello();
    expect(result).toEqual(HELLO);
    expect(c.wake.launches).toBe(1);
    expect(c.at()).toBeLessThanOrEqual(3_500);
  });

  it("waits at most 20 seconds, then answers app-not-running", async () => {
    const c = clock(true);
    const call = vi.fn(async (_op: string, _args: unknown, timeoutMs: number) => {
      expect(timeoutMs).toBeGreaterThan(0);
      c.advance(Math.min(timeoutMs, 700));
      return { ok: false as const, down: true };
    });
    const result = await makeRelayHost(DEVICE, call as never, c.wake).hello();
    expect(result).toMatchObject({ ok: false, error: { code: "app-not-running" } });
    expect(c.wake.launches).toBe(1);
    // The first attempt precedes the launch; the wait after it is bounded.
    expect(c.at() - 700).toBeLessThanOrEqual(COMPANION_LAUNCH_WAIT_MS);
  });

  it("answers app-not-running at once when the installed app may not be started", async () => {
    const c = clock(false);
    const call = vi.fn(async () => ({ ok: false as const, down: true }));
    const result = await makeRelayHost(DEVICE, call as never, c.wake).hello();
    expect(result).toMatchObject({ ok: false, error: { code: "app-not-running" } });
    expect(call).toHaveBeenCalledTimes(1);
    expect(c.at()).toBe(0);
  });

  it("starts nothing when the app is running", async () => {
    const c = clock(true);
    const answered = await makeRelayHost(DEVICE, vi.fn(async () => ({ ok: true as const, data: HELLO })) as never, c.wake).hello();
    expect(answered).toEqual(HELLO);
    const failed = await makeRelayHost(DEVICE, vi.fn(async () => ({ ok: false as const, down: false })) as never, c.wake).hello();
    expect(failed).toMatchObject({ ok: false, error: { code: "internal" } });
    expect(c.wake.launches).toBe(0);
  });
});
