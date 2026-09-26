import { describe, expect, it } from "vitest";
import { CUE_IDS, CUES, cuesInCategory } from "../src/renderer/lib/sound/cues";
import { CueMixer, MIXER_LIMITS } from "../src/renderer/lib/sound/mixer";
import { SOUND_CATEGORIES } from "@shared/settings";

const mixer = () => new CueMixer(CUES);

describe("sound mixer", () => {
  it("coalesces a fifty-seat burst of the same cue into one fuller play", () => {
    const m = mixer();
    const outcomes = Array.from({ length: 50 }, (_, i) => m.request("done", i * 2));
    expect(outcomes[0]).toBe("queued");
    expect(outcomes.slice(1).every((o) => o === "coalesced")).toBe(true);
    expect(m.due(100)).toEqual([]);
    const plays = m.due(CUES.done.coalesceMs);
    expect(plays).toHaveLength(1);
    expect(plays[0]!.variant.count).toBe(50);
  });

  it("drops a repeat inside the cue's own gap and plays it after", () => {
    const m = mixer();
    m.request("working", 0);
    expect(m.due(CUES.working.coalesceMs)).toHaveLength(1);
    expect(m.request("working", CUES.working.coalesceMs + 10)).toBe("dropped");
    expect(m.request("working", CUES.working.coalesceMs + CUES.working.minGapMs)).toBe("queued");
  });

  it("plays one attention cue at a time and lets only a more urgent one take over", () => {
    const m = mixer();
    m.request("waiting", 0);
    const [first] = m.due(0);
    expect(first!.cue).toBe("waiting");

    m.request("failed", 100);
    expect(m.due(100)).toEqual([]);

    m.request("blocked", 200);
    const [louder] = m.due(200);
    expect(louder!.cue).toBe("blocked");
    expect(louder!.steal).toEqual([first!.id]);
  });

  it("keeps the hush after an attention cue, then opens again", () => {
    const m = mixer();
    m.request("blocked", 0);
    m.due(0);
    const hushEnds = CUES.blocked.seconds * 1_000 + MIXER_LIMITS.attentionHushMs;
    m.request("waiting", hushEnds - 1);
    expect(m.due(hushEnds - 1)).toEqual([]);
    m.request("waiting", hushEnds + 1);
    expect(m.due(hushEnds + 1).map((p) => p.cue)).toEqual(["waiting"]);
  });

  it("gives the quiet families a shared budget so a canvas-wide burst stays a few notes", () => {
    const m = mixer();
    const quiet = ["working", "answered", "squad", "review", "done", "mail", "navigate", "bell"] as const;
    let played = 0;
    for (const [i, cue] of quiet.entries()) {
      m.request(cue, i);
    }
    played += m.due(1_000).length;
    expect(played).toBeLessThanOrEqual(MIXER_LIMITS.ambientBudget);
  });

  it("an attention cue still sounds through a full budget and full voices", () => {
    const m = mixer();
    for (const cue of ["working", "answered", "squad", "review"] as const) m.request(cue, 0);
    const quiet = m.due(1_000);
    expect(quiet.length).toBe(MIXER_LIMITS.maxVoices);
    m.request("blocked", 1_001);
    const [blocked] = m.due(1_001);
    expect(blocked!.cue).toBe("blocked");
    expect(blocked!.steal).toHaveLength(1);
  });

  it("carries the newest mail tone and the stereo position of the burst", () => {
    const m = mixer();
    m.request("mail", 0, { tone: "notice", pan: -0.5 });
    m.request("mail", 10, { tone: "answer", pan: 0.2 });
    const [play] = m.due(CUES.mail.coalesceMs);
    expect(play!.variant).toEqual({ count: 2, tone: "answer", pan: 0.2 });
  });

  it("flushes every coalescing window at once when asked (hidden window)", () => {
    const m = mixer();
    m.request("done", 0);
    expect(m.due(1, true)).toHaveLength(1);
  });
});

describe("cue catalog", () => {
  it("is louder the more urgent the cue", () => {
    const levels = (urgency: number) =>
      CUE_IDS.filter((id) => CUES[id].urgency === urgency).map((id) => CUES[id].level);
    for (let urgency = 1; urgency <= 4; urgency += 1) {
      expect(Math.min(...levels(urgency))).toBeGreaterThan(Math.max(...levels(urgency - 1)));
    }
  });

  it("puts every family to use and every cue in exactly one family", () => {
    for (const category of SOUND_CATEGORIES) expect(cuesInCategory(category).length).toBeGreaterThan(0);
    expect(SOUND_CATEGORIES.flatMap(cuesInCategory).sort()).toEqual([...CUE_IDS].sort());
  });

  it("names every cue in plain words, without middle dots", () => {
    for (const id of CUE_IDS) {
      expect(CUES[id].label.length).toBeGreaterThan(0);
      expect(`${CUES[id].label}${CUES[id].meaning}`).not.toContain("·");
    }
  });
});
