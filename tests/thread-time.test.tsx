// @vitest-environment jsdom
/**
 * When a thread or a message was written, as every thread list and message
 * says it: the hour today, the day before that, and the whole date and time
 * for the hover and for a screen reader.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTime } from "../src/window/components/threads/ThreadTime";
import { pinThreadToday, threadWhen } from "../src/window/lib/thread-time";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// Monday 23 November 2026, mid afternoon, on this machine's clock.
const NOW = new Date(2026, 10, 23, 15, 30).getTime();
const on = (year: number, month: number, day: number, hours = 14, minutes = 5) => new Date(year, month - 1, day, hours, minutes).getTime();

describe("how a thread's time reads", () => {
  it("is the hour today", () => {
    expect(threadWhen(on(2026, 11, 23, 9, 7), NOW)).toMatchObject({ row: "09:07", message: "09:07" });
    // The first minute of today is still today.
    expect(threadWhen(on(2026, 11, 23, 0, 0), NOW).row).toBe("00:00");
  });

  it("is the word Yesterday the day before, however few hours ago", () => {
    expect(threadWhen(on(2026, 11, 22, 23, 59), NOW)).toMatchObject({ row: "Yesterday", message: "Yesterday 23:59" });
    expect(threadWhen(on(2026, 11, 22, 0, 0), NOW).row).toBe("Yesterday");
  });

  it("is the weekday for the five days before yesterday", () => {
    expect(threadWhen(on(2026, 11, 21), NOW)).toMatchObject({ row: "Sat", message: "Sat 14:05" });
    expect(threadWhen(on(2026, 11, 17), NOW)).toMatchObject({ row: "Tue", message: "Tue 14:05" });
  });

  it("is the date from a week back, so a weekday never names two days", () => {
    // Last Monday is not "Mon": today is Monday.
    expect(threadWhen(on(2026, 11, 16), NOW)).toMatchObject({ row: "16 Nov", message: "16 Nov 14:05" });
    expect(threadWhen(on(2026, 1, 3), NOW).row).toBe("3 Jan");
  });

  it("carries the year when it is not this one", () => {
    expect(threadWhen(on(2025, 11, 12), NOW)).toMatchObject({ row: "12 Nov 2025", message: "12 Nov 2025 14:05" });
    // The year turned two days ago: still a weekday, the year is not what tells it.
    const january = new Date(2027, 0, 2, 10, 0).getTime();
    expect(threadWhen(on(2026, 12, 31), january).row).toBe("Thu");
  });

  it("says the whole date and time for the hover and for a screen reader", () => {
    expect(threadWhen(on(2026, 11, 17), NOW).whole).toBe("Tuesday 17 November 2026, 14:05");
    expect(threadWhen(on(2026, 11, 23, 9, 7), NOW).whole).toBe("Monday 23 November 2026, 09:07");
  });

  it("reads a time a little ahead as today: another machine's clock, never tomorrow", () => {
    expect(threadWhen(NOW + 5 * 60_000, NOW).row).toBe("15:35");
    expect(threadWhen(on(2026, 11, 24, 0, 2), NOW)).toMatchObject({ row: "00:02", message: "00:02" });
  });

  it("counts days by the calendar across a clock change", () => {
    // Europe's clocks went back on 25 October 2026; wherever this runs, the 24th is two days before the 26th.
    const monday = new Date(2026, 9, 26, 0, 30).getTime();
    expect(threadWhen(on(2026, 10, 24, 23, 30), monday).row).toBe("Sat");
    expect(threadWhen(on(2026, 10, 25, 23, 30), monday).row).toBe("Yesterday");
  });
});

describe("the time as it is drawn", () => {
  let host: HTMLElement;
  let root: Root;

  beforeEach(() => {
    pinThreadToday(NOW);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    pinThreadToday();
    vi.useRealTimers();
  });

  const time = () => host.querySelector("time") as HTMLElement;

  it("draws the short form and gives the whole to the hover and to a screen reader", () => {
    act(() => root.render(<ThreadTime at={on(2026, 11, 17)} className="seat-threads__row-time" />));
    expect(time().className).toBe("seat-threads__row-time");
    expect(time().getAttribute("title")).toBe("Tuesday 17 November 2026, 14:05");
    expect(time().getAttribute("datetime")).toBe(new Date(on(2026, 11, 17)).toISOString());
    const [drawn, said] = [...time().children] as HTMLElement[];
    expect(drawn?.textContent).toBe("Tue");
    expect(drawn?.getAttribute("aria-hidden")).toBe("true");
    expect(said?.textContent).toBe("Tuesday 17 November 2026, 14:05");
    expect(said?.className).toBe("sr-only");
  });

  it("gives a message the hour with its day", () => {
    act(() => root.render(<ThreadTime at={on(2026, 11, 22, 8, 0)} form="message" />));
    expect(time().firstElementChild?.textContent).toBe("Yesterday 08:00");
  });

  it("turns at midnight while it is shown, not at the next read", () => {
    pinThreadToday();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 23, 23, 58));
    const at = new Date(2026, 10, 23, 14, 5).getTime();
    act(() => root.render(<ThreadTime at={at} />));
    expect(time().firstElementChild?.textContent).toBe("14:05");
    act(() => {
      vi.advanceTimersByTime(3 * 60_000);
    });
    expect(time().firstElementChild?.textContent).toBe("Yesterday");
    // And again the night after: the watch is kept, and Monday is now two days back.
    act(() => {
      vi.advanceTimersByTime(DAY);
    });
    expect(time().firstElementChild?.textContent).toBe("Mon");
  });
});

const DAY = 86_400_000;
