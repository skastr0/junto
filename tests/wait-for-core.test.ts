/**
 * A failure because no core answered is told apart from a refusal the core
 * itself answered (core-process/wait-for-core.ts), so the startup dialog names
 * the core only when it is what did not answer.
 */
import { expect, it } from "vitest";
import { BrowserProfileError } from "../src/node/browser/profiles";
import { RpcClientError } from "effect/rpc";
import { CoreCallError } from "../src/contract/core/client";
import { isCoreUnavailable } from "../src/app/core-process/wait-for-core";

const stopped = (): CoreCallError => new CoreCallError("browser.profiles.initialize", "CoreStopped", "the Junto core process exited with code 1");
const refused = (): CoreCallError => new CoreCallError("browser.profiles.initialize", "BrowserProfileError", "no such profile");

it("names the ways a core can be missing, and nothing else", () => {
  const left = new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ message: "the Junto core process exited with code 1", cause: undefined }),
  });
  expect(isCoreUnavailable(left)).toBe(true);
  expect(isCoreUnavailable(new CoreCallError("x", "CoreStopped", "gone"))).toBe(true);
  expect(isCoreUnavailable(new CoreCallError("x", "CoreClientMissing", "none installed"))).toBe(true);
  expect(isCoreUnavailable(new CoreCallError("x", "SettingsError", "bad"))).toBe(false);
  expect(isCoreUnavailable(new Error("boom"))).toBe(false);
});

it("sees a core refusal through the wrappers a caller put around it", () => {
  const wrapper = new Error("browser security initialization failed; browser startup blocked");
  wrapper.cause = new BrowserProfileError({
    message: "browser profile registry unavailable",
    code: "io",
    cause: stopped(),
  });
  expect(isCoreUnavailable(wrapper)).toBe(true);

  const refusedWrapper = new Error("browser security initialization failed; browser startup blocked");
  refusedWrapper.cause = new BrowserProfileError({
    message: "browser profile registry unavailable",
    code: "io",
    cause: refused(),
  });
  expect(isCoreUnavailable(refusedWrapper)).toBe(false);
});
