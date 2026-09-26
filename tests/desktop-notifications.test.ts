import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  DONE_SETTLE_MS,
  POSTS_PER_ABSENCE,
  URGENT_SETTLE_MS,
  badgeCount,
  emptyNotifyState,
  flush,
  nameList,
  nextFlushAt,
  observe,
  oneLine,
  setAway,
  type NotifyCategory,
  type NotifyState,
  type NotifySubject,
} from "../src/shared/desktop-notifications";
import {
  Settings,
  SettingsPatch,
  applySettingsPatch,
  defaultNotifications,
  defaultSection,
  defaultSettings,
  notificationSettings,
} from "../src/shared/settings";
import { decodeStoredSettings, preferencesFromSettings } from "../src/main/junto/settings/state-schema";

const prefs = defaultNotifications();

const need = (
  nodeId: string,
  category: NotifyCategory,
  text = "can I delete the old migrations?",
  key = `${category}:${nodeId}`,
): NotifySubject => ({ key, category, canvasName: "main", nodeId, seatName: nodeId, text });

/** Observe, then flush at a time. */
const step = (state: NotifyState, subjects: ReadonlyArray<NotifySubject>, at: number, flushAt = at) => {
  const observed = observe(state, subjects, at).state;
  return flush(observed, flushAt, prefs);
};

const awayWith = (subjects: ReadonlyArray<NotifySubject> = []): NotifyState =>
  setAway(observe(emptyNotifyState(), subjects, 0).state, true);

describe("desktop notification policy", () => {
  it("posts nothing while the window is in front", () => {
    const state = observe(emptyNotifyState(), [need("maple", "blocked")], 0).state;
    expect(flush(state, URGENT_SETTLE_MS * 10, prefs).posts).toEqual([]);
    expect(nextFlushAt(state)).toBeNull();
  });

  it("treats what was open when the operator left as already seen", () => {
    const state = awayWith([need("maple", "blocked")]);
    const { posts } = step(state, [need("maple", "blocked")], 10, 10 + URGENT_SETTLE_MS);
    expect(posts).toEqual([]);
  });

  it("posts a need that rises while away, once it settles", () => {
    const state = observe(awayWith(), [need("maple", "needsYou", "wants your input")], 100).state;
    expect(nextFlushAt(state)).toBe(100 + URGENT_SETTLE_MS);
    expect(flush(state, 100 + URGENT_SETTLE_MS - 1, prefs).posts).toEqual([]);
    const { posts } = flush(state, 100 + URGENT_SETTLE_MS, prefs);
    expect(posts).toEqual([
      {
        tag: "seat:main:maple",
        title: "maple",
        subtitle: "Needs you",
        body: "wants your input",
        target: { kind: "seat", canvasName: "main", nodeId: "maple" },
        cue: "needs-you",
        bounce: false,
        keys: ["needsYou:maple"],
      },
    ]);
  });

  it("never posts a need that resolved before it settled", () => {
    let state = observe(awayWith(), [need("maple", "needsYou")], 100).state;
    state = observe(state, [], 200).state;
    expect(nextFlushAt(state)).toBeNull();
    expect(flush(state, 100 + URGENT_SETTLE_MS, prefs).posts).toEqual([]);
  });

  it("does not post twice for the same need", () => {
    const first = step(awayWith(), [need("maple", "blocked")], 0, URGENT_SETTLE_MS);
    expect(first.posts).toHaveLength(1);
    const again = step(first.state, [need("maple", "blocked")], URGENT_SETTLE_MS + 1, URGENT_SETTLE_MS * 5);
    expect(again.posts).toEqual([]);
  });

  it("posts one notification per seat per absence, unless the seat gets worse", () => {
    const first = step(awayWith(), [need("maple", "needsYou", "one", "a")], 0, URGENT_SETTLE_MS);
    expect(first.posts).toHaveLength(1);
    // A second question on the same seat stays quiet: the seat already told them.
    const second = step(first.state, [need("maple", "needsYou", "two", "b")], 5_000, 5_000 + URGENT_SETTLE_MS);
    expect(second.posts).toEqual([]);
    // Blocked outranks needs-you: it replaces the delivered banner by tag.
    const worse = step(second.state, [need("maple", "blocked", "stuck on auth", "c")], 9_000, 9_000 + URGENT_SETTLE_MS);
    expect(worse.posts.map((post) => [post.tag, post.subtitle, post.bounce])).toEqual([
      ["seat:main:maple", "Blocked", true],
    ]);
  });

  it("keeps the most urgent need when one seat raises several at once", () => {
    const { posts } = step(
      awayWith(),
      [need("maple", "needsYou", "question", "q"), need("maple", "blocked", "stuck", "s")],
      0,
      URGENT_SETTLE_MS,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ subtitle: "Blocked", body: "stuck", keys: ["q", "s"] });
  });

  it("folds a burst across many seats into one summary that opens the feed", () => {
    const seats = ["maple", "pip", "clove", "juniper", "sage"];
    const { posts } = step(
      awayWith(),
      seats.map((seat, index) => need(seat, index === 0 ? "blocked" : "needsYou")),
      0,
      URGENT_SETTLE_MS,
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      tag: "summary:needs:main",
      title: "5 agents need you",
      subtitle: "1 blocked",
      body: "maple, clove, juniper and 2 more",
      target: { kind: "feed", canvasName: "main" },
      cue: "summary",
      bounce: true,
    });
  });

  it("posts each seat of a small burst on its own, most urgent first", () => {
    const { posts } = step(
      awayWith(),
      [need("pip", "needsYou"), need("maple", "failed", "exited with code 1"), need("clove", "blocked")],
      0,
      URGENT_SETTLE_MS,
    );
    expect(posts.map((post) => [post.title, post.cue])).toEqual([
      ["clove", "blocked"],
      ["maple", "failed"],
      ["pip", "needs-you"],
    ]);
  });

  it("summarises everything past the per-absence cap", () => {
    let state = awayWith();
    let at = 0;
    const counts: number[] = [];
    for (let index = 0; index < POSTS_PER_ABSENCE + 2; index += 1) {
      const result = step(state, [need(`seat-${index}`, "needsYou")], at, at + URGENT_SETTLE_MS);
      state = result.state;
      counts.push(result.posts.length);
      at += 10_000;
      if (index === POSTS_PER_ABSENCE) expect(result.posts[0]?.target.kind).toBe("feed");
    }
    expect(counts.every((count) => count === 1)).toBe(true);
  });

  it("gathers finished seats on a longer clock and sends them together, without a bounce", () => {
    let state = observe(awayWith(), [need("maple", "done", "tests pass")], 0).state;
    state = observe(state, [need("maple", "done", "tests pass"), need("pip", "done")], 4_000).state;
    expect(nextFlushAt(state)).toBe(DONE_SETTLE_MS);
    expect(flush(state, URGENT_SETTLE_MS, prefs).posts).toEqual([]);
    const { posts } = flush(state, DONE_SETTLE_MS, prefs);
    expect(posts).toEqual([
      expect.objectContaining({ title: "2 agents finished", body: "maple and pip", cue: "done", bounce: false }),
    ]);
  });

  it("says a single finished seat by name, with its line", () => {
    const { posts } = step(awayWith(), [need("maple", "done", "tests pass")], 0, DONE_SETTLE_MS);
    expect(posts[0]).toMatchObject({ title: "maple", subtitle: "Finished", body: "tests pass", cue: "done" });
  });

  it("does not post a finish for a seat that already raised a need this absence", () => {
    const first = step(awayWith(), [need("maple", "blocked")], 0, URGENT_SETTLE_MS);
    const { posts } = step(first.state, [need("maple", "done", "ok", "d")], 2_000, 2_000 + DONE_SETTLE_MS);
    expect(posts).toEqual([]);
  });

  it("honours each category switch and the master switch", () => {
    const quiet = { ...prefs, blocked: false };
    const state = observe(awayWith(), [need("maple", "blocked"), need("pip", "needsYou")], 0).state;
    expect(flush(state, URGENT_SETTLE_MS, quiet).posts.map((post) => post.title)).toEqual(["pip"]);
    const off = flush(state, URGENT_SETTLE_MS, { ...prefs, enabled: false });
    expect(off.posts).toEqual([]);
    // Switched-off needs are still handled: turning it on later does not replay them.
    expect(flush(off.state, URGENT_SETTLE_MS * 4, prefs).posts).toEqual([]);
  });

  it("bounces only for blocked, and only with the bounce setting on", () => {
    const state = observe(awayWith(), [need("maple", "blocked")], 0).state;
    expect(flush(state, URGENT_SETTLE_MS, prefs).posts[0]?.bounce).toBe(true);
    expect(flush(state, URGENT_SETTLE_MS, { ...prefs, bounce: false }).posts[0]?.bounce).toBe(false);
  });

  it("coming back to the window drops what was pending and starts a fresh absence", () => {
    let state = observe(awayWith(), [need("maple", "blocked")], 0).state;
    state = setAway(state, false);
    expect(nextFlushAt(state)).toBeNull();
    state = setAway(state, true);
    expect(step(state, [need("maple", "blocked")], 10, 10 + URGENT_SETTLE_MS).posts).toEqual([]);
    // A new absence may post the same seat again for a new need.
    const next = step(state, [need("maple", "blocked"), need("maple", "needsYou", "q", "q2")], 20, 20 + URGENT_SETTLE_MS);
    expect(next.posts).toHaveLength(1);
  });

  it("reports resolved keys so delivered banners can close", () => {
    const first = step(awayWith(), [need("maple", "blocked")], 0, URGENT_SETTLE_MS);
    expect(observe(first.state, [], URGENT_SETTLE_MS + 1).resolved).toEqual(["blocked:maple"]);
  });

  it("badges the feed count, or nothing with the badge off", () => {
    expect(badgeCount({ badge: 3, prefs })).toBe(3);
    expect(badgeCount({ badge: 3, prefs: { ...prefs, badge: false } })).toBe(0);
    expect(badgeCount({ badge: -2, prefs })).toBe(0);
  });

  it("keeps banner text to one short line, and lists names with commas", () => {
    expect(oneLine("  line one\n\nline two  ")).toBe("line one line two");
    expect(oneLine("x".repeat(400))).toHaveLength(140);
    expect(nameList(["a"])).toBe("a");
    expect(nameList(["a", "b"])).toBe("a and b");
    expect(nameList(["a", "b", "c", "d"])).toBe("a, b, c and 1 more");
    expect(nameList(["a", "b", "c", "d"]).includes("·")).toBe(false);
  });
});

describe("notification settings", () => {
  const decodePatch = Schema.decodeUnknownSync(SettingsPatch, { onExcessProperty: "error" });
  const decodeSettings = Schema.decodeUnknownSync(Settings, { onExcessProperty: "error" });

  it("defaults every switch on and resets to that", () => {
    expect(notificationSettings(defaultSettings())).toEqual(defaultNotifications());
    expect(defaultSection("notifications")).toEqual(defaultNotifications());
    expect(Object.values(defaultNotifications()).every(Boolean)).toBe(true);
  });

  it("decodes rows written before notifications as the defaults", () => {
    const settings = defaultSettings();
    const { notifications: _notifications, ...prefsRow } = preferencesFromSettings(settings);
    const decoded = decodeStoredSettings(1, prefsRow, settings.station);
    expect(notificationSettings(decoded)).toEqual(defaultNotifications());
  });

  it("patches one switch and round-trips through storage", () => {
    const patched = applySettingsPatch(defaultSettings(), decodePatch({ notifications: { done: false } }));
    expect(notificationSettings(patched)).toEqual({ ...defaultNotifications(), done: false });
    decodeSettings(patched);
    const stored = decodeStoredSettings(1, preferencesFromSettings(patched), patched.station);
    expect(notificationSettings(stored).done).toBe(false);
  });
});
