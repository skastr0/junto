import { Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_WAITING, encodeCorePush } from "../src/contract/core/channels";
import { deliverPush, subscribe } from "../src/app/core-process/main-side/core-pushes";
import type { MailWaitingFact } from "../src/shared/mail-waiting";

/**
 * A core push is encoded with its channel's Schema where the core publishes
 * it, and decoded closed where main receives it (`deliverPush`). What does not
 * decode is logged with its channel and reaches no subscriber, so no window.
 */
describe("core pushes, decoded at receipt", () => {
  const fact: MailWaitingFact = { canvasName: "factory", nodeId: "agent-1", count: 2, heldSince: 1_700_000_000_000, hold: "busy" };
  const offs: Array<() => void> = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
    vi.restoreAllMocks();
  });

  const hear = () => {
    const heard: unknown[] = [];
    offs.push(subscribe(MAIL_WAITING, (payload) => heard.push(payload)));
    return heard;
  };

  it("hands a subscriber what the core encoded, as the core published it", () => {
    const heard = hear();
    const encoded = encodeCorePush(MAIL_WAITING, fact);
    expect(Result.isSuccess(encoded)).toBe(true);
    if (Result.isSuccess(encoded)) deliverPush(MAIL_WAITING, encoded.success);
    expect(heard).toEqual([fact]);
  });

  it("refuses a wrong payload for its channel: logged with the channel, never relayed", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const heard = hear();
    deliverPush(MAIL_WAITING, { canvasName: "factory", nodeId: "agent-1", count: "two" });
    expect(heard).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(String(logged.mock.calls[0]?.[0])).toContain(MAIL_WAITING);
  });

  it("refuses a key its Schema does not name, as a wrong value", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const heard = hear();
    deliverPush(MAIL_WAITING, { ...fact, text: "a mail's text never rides this push" });
    expect(heard).toEqual([]);
  });

  it("sends no key past the Schema from the core", () => {
    const encoded = encodeCorePush(MAIL_WAITING, { ...fact, text: "dropped" } as MailWaitingFact);
    expect(Result.isSuccess(encoded) && encoded.success).toEqual(fact);
  });
});
