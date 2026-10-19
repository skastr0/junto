import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  QUIT_MARKER_WAIT_MS,
  quitMarkerPath,
  requestLockAfterQuittingHolder,
  writeQuitMarker,
} from "../src/main/junto/quit-marker";

const homes: string[] = [];
const home = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "junto-quit-marker-"));
  homes.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake clock: sleep advances it, so a 15 s wait runs in no time.
const clock = () => {
  let at = 0;
  return { now: () => at, sleep: (ms: number) => { at += ms; }, elapsed: () => at };
};

describe("the relaunch wait", () => {
  it("waits while a quitting holder lives, then holds the lock on one request", () => {
    const path = quitMarkerPath(home());
    writeQuitMarker(path, { pid: 4242, startKey: "quitting-a" });
    const time = clock();
    const requests: number[] = [];
    const got = requestLockAfterQuittingHolder({
      markerPath: path,
      // The quitting app and its lock are gone 2.5 s into its native teardown.
      requestLock: () => { requests.push(time.elapsed()); return time.elapsed() >= 2_500; },
      startKeyOf: () => (time.elapsed() < 2_500 ? "quitting-a" : undefined),
      now: time.now,
      sleep: time.sleep,
    });
    expect(got).toBe(true);
    expect(requests).toEqual([2_500]);
    expect(existsSync(path)).toBe(false);
  });

  it("exits on the first try beside a healthy holder, which leaves no marker", () => {
    const time = clock();
    let requests = 0;
    const got = requestLockAfterQuittingHolder({
      markerPath: quitMarkerPath(home()),
      requestLock: () => { requests += 1; return false; },
      startKeyOf: () => "healthy",
      now: time.now,
      sleep: time.sleep,
    });
    expect(got).toBe(false);
    expect(requests).toBe(1);
    expect(time.elapsed()).toBe(0);
  });

  it("does not wait on a marker whose process is gone or whose pid is someone else now", () => {
    const path = quitMarkerPath(home());
    writeQuitMarker(path, { pid: 4242, startKey: "quitting-a" });
    for (const startKey of [undefined, "reused-pid"]) {
      const time = clock();
      let requests = 0;
      expect(requestLockAfterQuittingHolder({
        markerPath: path,
        requestLock: () => { requests += 1; return false; },
        startKeyOf: () => startKey,
        now: time.now,
        sleep: time.sleep,
      })).toBe(false);
      expect(time.elapsed()).toBe(0);
      expect(requests).toBe(1);
    }
  });

  it("asks once at the bound when the quitting holder never goes", () => {
    const path = quitMarkerPath(home());
    writeQuitMarker(path, { pid: 4242, startKey: "quitting-a" });
    const time = clock();
    const requests: number[] = [];
    expect(requestLockAfterQuittingHolder({
      markerPath: path,
      requestLock: () => { requests.push(time.elapsed()); return false; },
      startKeyOf: () => "quitting-a",
      now: time.now,
      sleep: time.sleep,
    })).toBe(false);
    expect(requests).toEqual([QUIT_MARKER_WAIT_MS]);
    // A launch that did not get the lock leaves the marker to its writer.
    expect(existsSync(path)).toBe(true);
  });

  it("writes the marker owner-only in the run's own home, replacing a symlink without following it", () => {
    const dir = home();
    const path = quitMarkerPath(dir);
    const elsewhere = join(dir, "elsewhere.txt");
    writeFileSync(elsewhere, "untouched");
    symlinkSync(elsewhere, path);
    // The staged name is predictable too.
    symlinkSync(elsewhere, `${path}.${process.pid}.tmp`);

    writeQuitMarker(path, { pid: 4242, startKey: "quitting-a" });
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ pid: 4242, startKey: "quitting-a" });
    expect(readFileSync(elsewhere, "utf8")).toBe("untouched");
  });

  it("ignores a marker that is not a pid and a start time", () => {
    const path = quitMarkerPath(home());
    mkdirSync(join(path, ".."), { recursive: true });
    for (const body of ["not json", "{}", '{"pid":1,"startKey":"x"}', '{"pid":4242,"startKey":""}']) {
      writeFileSync(path, body);
      const time = clock();
      expect(requestLockAfterQuittingHolder({
        markerPath: path,
        requestLock: () => false,
        startKeyOf: () => "x",
        now: time.now,
        sleep: time.sleep,
      })).toBe(false);
      expect(time.elapsed()).toBe(0);
    }
  });
});
