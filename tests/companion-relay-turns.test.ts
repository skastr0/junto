/**
 * One phone relays at most COMPANION_RELAY_CALLS_MAX requests over the
 * operator control socket at once, so a burst queues instead of taking all
 * eight peer slots; and a refusal for a full socket reads as rate-limited,
 * not as an app that is not running (found by app-remote: 291 portrait.get,
 * 284 internal errors).
 */
import { describe, expect, it } from "vitest";
import { COMPANION_RELAY_CALLS_MAX, makeRelayHost } from "../src/cli/companion-stdio";
import { COMPANION_PROTOCOL, companionOk, type CompanionRequestFrame } from "../src/shared/companion-protocol";

const DEVICE = "dev_01M594P2JVSWRGRSHY8GWTJN5B";
const ping = (id: string): CompanionRequestFrame => ({ v: COMPANION_PROTOCOL, type: "request", id, op: "ping", args: {} }) as CompanionRequestFrame;

describe("the relay's turns", () => {
  it("never has more than its share of the socket in flight, and answers every request", async () => {
    let open = 0;
    let most = 0;
    const call = async (_op: string, args: { readonly request: CompanionRequestFrame }) => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      open -= 1;
      return { ok: true, data: { response: companionOk(args.request.id, "ping", { serverTime: 1 }) } };
    };
    const host = makeRelayHost(DEVICE, call as never);
    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => host.call(ping(`p${i}`))));
    expect(answers.every((answer) => answer.ok)).toBe(true);
    expect(most).toBe(COMPANION_RELAY_CALLS_MAX);
  });

  it("answers a full socket as rate-limited, and a socket that is gone as app-not-running", async () => {
    const busy = makeRelayHost(DEVICE, (async () => ({ ok: false, down: false, busy: true })) as never);
    expect(await busy.call(ping("b"))).toMatchObject({ ok: false, error: { code: "rate-limited" } });
    const down = makeRelayHost(DEVICE, (async () => ({ ok: false, down: true })) as never);
    expect(await down.call(ping("d"))).toMatchObject({ ok: false, error: { code: "app-not-running" } });
  });
});
