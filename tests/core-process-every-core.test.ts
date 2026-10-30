/**
 * What main asks of a core, it asks of every core: a new core holds no watch
 * until it is asked, and a window hears of the new core only once it has them.
 */
import { describe, expect, it, vi } from "vitest";
import { askEveryCoreAsk, askOnEveryCore, askOnLaterCores } from "../src/main/core-process/every-core";

describe("asks of every core", () => {
  it("asks at once, and again on each new core, then says so", async () => {
    const watch = vi.fn(async () => undefined);
    askOnEveryCore("test.watch", watch);
    await vi.waitFor(() => expect(watch).toHaveBeenCalledTimes(1));
    const told = vi.fn();
    askEveryCoreAsk(told);
    await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("holds a later-cores ask until a new core, and one label holds one ask", async () => {
    const first = vi.fn(async () => undefined);
    const second = vi.fn(async () => undefined);
    askOnLaterCores("test.later", first);
    askOnLaterCores("test.later", second);
    expect(second).not.toHaveBeenCalled();
    const told = vi.fn();
    askEveryCoreAsk(told);
    await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("tries a refused ask again before the windows hear", async () => {
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("the core is still starting");
    });
    askOnLaterCores("test.flaky", flaky);
    const told = vi.fn();
    askEveryCoreAsk(told);
    await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(1), { timeout: 4_000 });
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it("a newer core's round takes over from one still running", async () => {
    let release: () => void = () => undefined;
    askOnLaterCores("test.flaky", async () => undefined);
    askOnLaterCores("test.slow", () => new Promise<void>((resolve) => { release = resolve; }));
    const stale = vi.fn();
    askEveryCoreAsk(stale);
    askOnLaterCores("test.slow", async () => undefined);
    const told = vi.fn();
    askEveryCoreAsk(told);
    await vi.waitFor(() => expect(told).toHaveBeenCalledTimes(1));
    release();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(stale).not.toHaveBeenCalled();
  });
});
