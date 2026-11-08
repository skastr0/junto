import { describe, expect, it } from "vitest";
import { PAUSED_CANVAS, pauseWasResumed } from "../src/shared/pause";

describe("pause law", () => {
  it("a canvas with no play decision is paused — born paused", () => {
    expect(PAUSED_CANVAS).toEqual({ playing: false, everPlayed: false });
  });

  it("only a canvas going from paused to playing counts as resumed", () => {
    const playing = { playing: true, everPlayed: true };
    const paused = { playing: false, everPlayed: true };
    expect(pauseWasResumed(paused, playing)).toBe(true);
    expect(pauseWasResumed(PAUSED_CANVAS, playing)).toBe(true);
    expect(pauseWasResumed(playing, playing)).toBe(false);
    expect(pauseWasResumed(playing, paused)).toBe(false);
  });
});
