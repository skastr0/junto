/**
 * A core call made while the core is starting again is waited out, and one the
 * core itself refused is not (core-process/wait-for-core.ts). The distinction
 * is what keeps a restarting core from taking the app down before the window.
 */
import { expect, it } from "vitest";
import { CoreCallError } from "../src/main/core-process/client";
import { awaitCore, isCoreUnavailable } from "../src/main/core-process/wait-for-core";

const stopped = (): CoreCallError => new CoreCallError("browser.profiles.initialize", "CoreStopped", "the Junto core process exited with code 1");
const refused = (): CoreCallError => new CoreCallError("browser.profiles.initialize", "BrowserProfileError", "no such profile");

it("waits out a core that is starting again, then answers", async () => {
  let calls = 0;
  const value = await awaitCore(async () => {
    calls += 1;
    if (calls < 3) throw stopped();
    return "ready";
  }, { wait: async () => undefined, retryMs: 0 });
  expect(value).toBe("ready");
  expect(calls).toBe(3);
});

it("does not wait out a refusal the core itself answered", async () => {
  let calls = 0;
  await expect(awaitCore(async () => {
    calls += 1;
    throw refused();
  }, { wait: async () => undefined })).rejects.toThrow("no such profile");
  expect(calls).toBe(1);
});

it("gives up once the core has had its time", async () => {
  let calls = 0;
  await expect(awaitCore(async () => {
    calls += 1;
    throw stopped();
  }, { deadlineMs: 0, wait: async () => undefined })).rejects.toThrow("exited with code 1");
  expect(calls).toBe(1);
});

it("names the two ways a core can be missing, and nothing else", () => {
  expect(isCoreUnavailable(new CoreCallError("x", "CoreStopped", "gone"))).toBe(true);
  expect(isCoreUnavailable(new CoreCallError("x", "CoreClientMissing", "none installed"))).toBe(true);
  expect(isCoreUnavailable(new CoreCallError("x", "SettingsError", "bad"))).toBe(false);
  expect(isCoreUnavailable(new Error("boom"))).toBe(false);
});
