/**
 * A failure because no core answered is told apart from a refusal the core
 * itself answered (core-process/wait-for-core.ts), so the startup dialog names
 * the core only when it is what did not answer.
 */
import { expect, it } from "vitest";
import { BrowserProfileError } from "../src/node/browser/profiles";
import { RpcClientError } from "effect/rpc";
import { isCoreUnavailable } from "../src/app/core-process/wait-for-core";

const stopped = (): RpcClientError.RpcClientError =>
  new RpcClientError.RpcClientError({
    reason: new RpcClientError.RpcClientDefect({ message: "the Junto core process exited with code 1", cause: undefined }),
  });
/** What the core answered: a refusal, which is not the core missing. */
const refused = (): Error => new Error("no such profile");

it("names the ways a core can be missing, and nothing else", () => {
  expect(isCoreUnavailable(stopped())).toBe(true);
  expect(isCoreUnavailable(refused())).toBe(false);
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
