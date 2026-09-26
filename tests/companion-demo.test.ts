/**
 * `junto companion-stdio --demo`: a full transcript against the built-in
 * canvas (hello first, every feed kind, seats in the ring vocabulary, an answer
 * that raises signal, feed and seat events, a conflict, mail, portraits), and
 * a smoke run of the real CLI entry over stdio. No app, no ~/.ssh.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEMO_CANVAS, DEMO_T0, demoRequest, makeDemoHost } from "../src/shared/companion-demo";
import { COMPANION_PROTOCOL } from "../src/shared/companion-protocol";
import { runCompanionSession } from "../src/shared/companion-session";
import { parseCompanionStdioArgs } from "../src/cli/companion-stdio";

type Frame = Record<string, any>;

/** A connection driven one line at a time. */
const connect = (options: { idleCloseMs?: number } = {}) => {
  const queue: string[] = [];
  let wakeReader: (() => void) | undefined;
  let ended = false;
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => ({
      next: async () => {
        while (queue.length === 0 && !ended) await new Promise<void>((resolve) => (wakeReader = resolve));
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        return { done: true, value: undefined };
      },
      return: async () => ({ done: true, value: undefined }),
    }),
  };
  const out: Frame[] = [];
  let wakeWriter: (() => void) | undefined;
  const done = runCompanionSession({
    lines,
    write: (line) => {
      expect(line.endsWith("\n")).toBe(true);
      out.push(JSON.parse(line));
      wakeWriter?.();
    },
    host: makeDemoHost({ appVersion: "test" }),
    waitMs: 40,
    ...(options.idleCloseMs !== undefined ? { idleCloseMs: options.idleCloseMs } : {}),
  });
  let read = 0;
  const next = async (): Promise<Frame> => {
    while (out.length <= read) await new Promise<void>((resolve) => (wakeWriter = resolve));
    return out[read++]!;
  };
  const until = async (match: (frame: Frame) => boolean): Promise<Frame> => {
    for (;;) {
      const frame = await next();
      if (match(frame)) return frame;
    }
  };
  return {
    send: (line: string) => {
      queue.push(line);
      wakeReader?.();
    },
    next,
    until,
    end: () => {
      ended = true;
      wakeReader?.();
      return done;
    },
    done,
    out,
  };
};

const response = (id: string) => (frame: Frame) => frame.type === "response" && frame.id === id;

describe("demo transcript", () => {
  it("speaks the whole protocol against the built-in canvas", async () => {
    const c = connect();
    const hello = await c.next();
    expect(hello).toEqual({
      v: COMPANION_PROTOCOL,
      type: "event",
      event: "hello",
      data: { appVersion: "test", deviceId: "dev_00000000000000000000DEM000", deviceName: "Demo phone", station: "Junto demo", serverTime: DEMO_T0 },
    });

    c.send(demoRequest("c1", "canvases.list"));
    expect((await c.until(response("c1"))).result).toEqual({
      canvases: [{ canvasName: DEMO_CANVAS, title: "Demo", active: true, playing: true, needsYou: 5 }],
    });

    // Every feed kind, grouped by region, most urgent section first.
    c.send(demoRequest("f1", "feed.subscribe"));
    const [feed] = (await c.until(response("f1"))).result.feeds;
    expect(feed.count).toBe(5);
    const kinds = feed.sections.flatMap((s: Frame) => s.items.map((i: Frame) => i.kind)).sort();
    expect(kinds).toEqual(["attention", "blocked", "escalate", "feedback", "health"]);
    expect(feed.sections.map((s: Frame) => s.region.label)).toEqual(["Backend", "Frontend"]);
    expect(feed.sections[0].items[0]).toMatchObject({ kind: "blocked", signalId: "sig_demo_blocked", ageMs: 12 * 60_000 });

    // Seats in the ring's words, eight of them across three regions.
    c.send(demoRequest("s1", "seats.list", { canvasName: DEMO_CANVAS }));
    const seats = (await c.until(response("s1"))).result.seats as Frame[];
    expect(seats.map((s) => [s.nodeId, s.state, s.line])).toEqual([
      ["atlas", "blocked", "blocked"],
      ["forge", "needs_input", "wants your input"],
      ["relay", "working", "AI reads: going well"],
      ["quill", "waiting_on_you", "wants you"],
      ["prism", "waiting_on_you", "ready for review"],
      ["ember", "waiting_on_you", "AI reads: wants your input"],
      ["sage", "trouble", "AI reads: thrashing"],
      ["lumen", "stopped", "stopped"],
    ]);
    expect(new Set(seats.map((s) => s.region.label))).toEqual(new Set(["Backend", "Frontend", "Research"]));

    // An answer: the response, then the events it causes.
    c.send(demoRequest("a1", "signal.answer", { signalId: "sig_demo_blocked", text: "It is in the vault under staging." }));
    const answered = await c.until(response("a1"));
    expect(answered.result.signal).toMatchObject({ state: "answered", response: { text: "It is in the vault under staging." } });
    const signalEvent = await c.until((f) => f.type === "event" && f.event === "signal.changed");
    expect(signalEvent.data.signal).toMatchObject({ signalId: "sig_demo_blocked", state: "answered" });
    const canvasesEvent = await c.until((f) => f.type === "event" && f.event === "canvases.changed");
    expect(canvasesEvent.data.canvases[0].needsYou).toBe(4);
    const feedEvent = await c.until((f) => f.type === "event" && f.event === "feed.changed");
    expect(feedEvent.data.feed.count).toBe(4);
    const seatEvent = await c.until((f) => f.type === "event" && f.event === "seat.changed");
    expect(seatEvent.data).toMatchObject({ canvasName: DEMO_CANVAS, seat: { nodeId: "atlas", state: "resting", line: "resting" } });

    // Answering it again is a conflict carrying the signal as it stands.
    c.send(demoRequest("a2", "signal.answer", { signalId: "sig_demo_blocked", text: "again" }));
    expect((await c.until(response("a2"))).error).toMatchObject({ code: "conflict", signal: { state: "answered" } });
    c.send(demoRequest("a3", "signal.dismiss", { signalId: "sig_nope" }));
    expect((await c.until(response("a3"))).error.code).toBe("not-found");

    // The answer went to the seat as operator mail, newest first.
    c.send(demoRequest("m1", "mail.list", { canvasName: DEMO_CANVAS, nodeId: "atlas", limit: 2 }));
    const mail = (await c.until(response("m1"))).result.messages as Frame[];
    expect(mail).toHaveLength(2);
    expect(mail[0]).toMatchObject({ direction: "to_seat", from: { kind: "operator" }, text: "It is in the vault under staging.", delivery: "delivered" });
    c.send(demoRequest("m2", "mail.send", { canvasName: DEMO_CANVAS, nodeId: "lumen", text: "Start with the second paper." }));
    expect((await c.until(response("m2"))).result.message).toMatchObject({ nodeId: "lumen", delivery: "waiting_for_seat" });

    c.send(demoRequest("q1", "quickReplies.get"));
    expect((await c.until(response("q1"))).result.replies.length).toBeGreaterThan(0);
    c.send(demoRequest("p1", "portrait.get", { portraitIdentity: "atlas", size: 96, theme: "dark" }));
    const svg = (await c.until(response("p1"))).result.svg as string;
    expect(svg.startsWith('<svg width="96" height="96" xmlns="http://www.w3.org/2000/svg"')).toBe(true);
    c.send(demoRequest("pc", "pair.complete", { publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDemoKey", deviceName: "x" }));
    expect((await c.until(response("pc"))).error.code).toBe("invalid");

    // The seat detail: briefing, live preambles, signal history, activity.
    c.send(demoRequest("g1", "seat.get", { canvasName: DEMO_CANVAS, nodeId: "atlas" }));
    const detail = (await c.until(response("g1"))).result.seat;
    expect(detail).toMatchObject({ nodeId: "atlas", state: "resting", briefing: expect.stringContaining("billing migration") });
    expect(detail.preambles.map((p: Frame) => p.preambleId)).toEqual(["pre_demo_atlas_2", "pre_demo_atlas_1"]);
    expect(detail.signals[0]).toMatchObject({ signalId: "sig_demo_blocked", state: "answered" });
    expect(detail.activity[0]).toMatchObject({ kind: "mail", label: "got your mail" });
    c.send(demoRequest("g2", "seat.get", { canvasName: DEMO_CANVAS, nodeId: "ghost" }));
    expect((await c.until(response("g2"))).error.code).toBe("not-found");
    // g2 failed, so atlas is still the focus: new mail to it arrives as mail.changed.
    c.send(demoRequest("m3", "mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: "Thanks." }));
    await c.until(response("m3"));
    const mailEvent = await c.until((f) => f.type === "event" && f.event === "mail.changed");
    expect(mailEvent.data).toMatchObject({ canvasName: DEMO_CANVAS, nodeId: "atlas", message: { text: "Thanks.", direction: "to_seat" } });

    c.send(demoRequest("u1", "feed.unsubscribe"));
    expect((await c.until(response("u1"))).result).toEqual({});
    c.send(demoRequest("z1", "ping"));
    expect((await c.until(response("z1"))).result.serverTime).toBeGreaterThan(DEMO_T0);
    await c.end();
  });

  it("is reproducible: two runs answer the same requests identically", async () => {
    const run = async () => {
      const c = connect();
      await c.next();
      c.send(demoRequest("f", "feed.get"));
      const feed = await c.until(response("f"));
      c.send(demoRequest("d", "signal.dismiss", { signalId: "sig_demo_feedback" }));
      const dismissed = await c.until(response("d"));
      await c.end();
      return [feed, dismissed];
    };
    expect(await run()).toEqual(await run());
  });

  it("closes on another protocol version and on an oversized frame", async () => {
    const c = connect();
    await c.next();
    c.send(JSON.stringify({ v: "junto-companion/9", type: "request", id: "x", op: "ping", args: {} }));
    expect(await c.next()).toMatchObject({ id: "x", ok: false, error: { code: "unsupported-version" } });
    await c.done;

    const big = connect();
    await big.next();
    big.send(demoRequest("b", "mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: "y".repeat(20_000) }));
    expect(await big.next()).toMatchObject({ id: "", ok: false, error: { code: "too-large" } });
    await big.done;
  });

  it("rate-limits writes past twenty in ten seconds", async () => {
    const c = connect();
    await c.next();
    for (let i = 0; i < 21; i += 1) {
      c.send(demoRequest(`w${i}`, "mail.send", { canvasName: DEMO_CANVAS, nodeId: "atlas", text: `note ${i}` }));
    }
    const last = await c.until(response("w20"));
    expect(last.error.code).toBe("rate-limited");
    await c.end();
  });

  it("closes a channel that stays silent", async () => {
    const c = connect({ idleCloseMs: 30 });
    await c.next();
    await c.done;
  });
});

describe("the CLI entry", () => {
  it("parses its arguments", () => {
    expect(parseCompanionStdioArgs(["--demo"])).toEqual({ ok: true, mode: "demo" });
    expect(parseCompanionStdioArgs(["--device", "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3"])).toEqual({
      ok: true,
      mode: "device",
      deviceId: "dev_01J9Z3K4M5N6P7Q8R9S0T1V2W3",
    });
    expect(parseCompanionStdioArgs([]).ok).toBe(false);
    expect(parseCompanionStdioArgs(["--device", "../../etc"]).ok).toBe(false);
    expect(parseCompanionStdioArgs(["--shell"]).ok).toBe(false);
  });

  it("serves the demo over real stdio", async () => {
    const child = spawn("bun", [join(process.cwd(), "src/cli/main.ts"), "companion-stdio", "--demo"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, HOME: "/nonexistent-home-for-companion-demo" },
    });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stdin.write(`${demoRequest("r1", "feed.get")}\n`);
    child.stdin.write(`${demoRequest("r2", "ping")}\n`);
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    const frames = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(code).toBe(0);
    expect(frames[0]).toMatchObject({ type: "event", event: "hello" });
    expect(frames.find((f) => f.id === "r1")?.result.feeds[0].count).toBe(5);
    expect(frames.find((f) => f.id === "r2")?.result.serverTime).toBe(DEMO_T0);
  }, 30_000);
});
