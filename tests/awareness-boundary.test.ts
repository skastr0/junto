/**
 * Awareness authority boundary — cement for the invariants no type can hold.
 *
 * The sidecar is advisory display only. It may not import or call
 * LocalSessionHost, SeatStateMachine, evaluate(), the composer verdict, the
 * drive modules, the canvas service, or process capabilities, and it must never
 * acknowledge a delivery, clear a stall, mark a seat seen, or author canvas
 * state. These tests read the three awareness sources as text and fail if a
 * forbidden dependency, a settlement accessor, or a bare Effect.runPromise
 * appears in them.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AwarenessObservationPlane } from "../src/main/junto/term/awareness/runtime";
import { computeWindowDigest } from "../src/main/junto/term/awareness/select-input";

const AWARENESS_DIR = join(process.cwd(), "src", "main", "junto", "term", "awareness");
const FILES = ["jev-client.ts", "scheduler.ts", "runtime.ts"] as const;

const read = (name: string): string => readFileSync(join(AWARENESS_DIR, name), "utf8");

/** Strip comments so prose about a forbidden name is not a violation. */
const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const code = (name: string): string => stripComments(read(name));

const FORBIDDEN = [
  // Seat, drive, and canvas authority.
  "LocalSessionHost",
  "SeatStateMachine",
  "evaluate(",
  "composerVerdict",
  "composerVerdictFor",
  "managed-terminal-drive",
  "managedDrive",
  "canvases",
  "CanvasesService",
  "junto/term/drive",
  "junto/term/agent-state",
  // Process and host capability.
  "process.kill",
  "process-signal",
  "spawn(",
  "execFile",
  // Grid settlement: awareness may never pull the writer forward.
  "readWindow(",
  "attachScreen",
  "isSettled",
  // Boundaries it has no business crossing.
  "ipcMain",
  "ipcRenderer",
  "webContents",
  "preload",
  "/renderer/",
  // Bare Effect.runPromise is banned under product main (S0 gate).
  "Effect.runPromise(",
] as const;

describe("awareness sources stay inside the advisory boundary", () => {
  for (const file of FILES) {
    it(`${file} imports and calls nothing outside the read-only ports`, () => {
      const source = code(file);
      for (const token of FORBIDDEN) {
        expect(source.includes(token), `${file} must not reference ${token}`).toBe(false);
      }
    });
  }

  it("imports only the observer types, the SDK, and its own modules", () => {
    for (const file of FILES) {
      const imports = [...code(file).matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);
      for (const specifier of imports) {
        const allowed =
          specifier === "effect" ||
          specifier === "node:crypto" ||
          specifier === "@typesafe-ai/sdk" ||
          specifier === "@shared/contracts" ||
          specifier === "../observer" ||
          specifier.startsWith("./");
        expect(allowed, `${file} imports ${specifier}`).toBe(true);
      }
    }
  });

  it("holds exactly the observer surface it needs, with no settlement accessor", () => {
    const port: AwarenessObservationPlane = {
      subscribeAll: () => () => undefined,
      snapshot: () => undefined,
      readWindowNow: () => undefined,
    };
    expect(Object.keys(port).sort()).toEqual(["readWindowNow", "snapshot", "subscribeAll"]);
    // @ts-expect-error the port deliberately has no flushing accessor
    const withFlush: AwarenessObservationPlane = { ...port, readWindow: () => undefined };
    expect(withFlush).toBeDefined();
  });

  it("keeps the observer callback synchronous", () => {
    const source = code("runtime.ts");
    expect(source.includes("const onSnapshot: ObserverListener = (snapshot) => {")).toBe(true);
    expect(source.includes("async")).toBe(false);
    expect(source.includes("await")).toBe(false);
  });

  it("never acknowledges anything", () => {
    for (const file of FILES) {
      const source = code(file).toLowerCase();
      for (const token of [
        "acknowledge",
        "acknowledgement",
        "mark_seen",
        "markseen",
        "clear_stall",
        "clearstall",
        "receipt(",
      ]) {
        expect(source.includes(token), `${file} must not ${token}`).toBe(false);
      }
    }
  });
});

describe("awareness never writes durable state", () => {
  it("has no database, filesystem write, or artifact surface", () => {
    for (const file of FILES) {
      const source = code(file);
      for (const token of [
        "node:fs",
        "writeFile",
        "appendFile",
        "StateEngine",
        "sqlite",
        "artifact",
      ]) {
        expect(source.includes(token), `${file} must not reference ${token}`).toBe(false);
      }
    }
  });
});

describe("one window normalization", () => {
  it("uses the projection's exported digest rather than a second one", () => {
    // The scheduler's cache key material is `evidenceHash`, which the projection
    // sets from `computeWindowDigest`; the awareness sources must not hash
    // evidence themselves.
    expect(computeWindowDigest({ bindingId: "s1", epoch: "e1", lines: [] })).toHaveLength(64);
    for (const file of FILES) {
      const source = code(file);
      expect(source.includes("createHash"), `${file} must not hash on its own`).toBe(false);
    }
  });
});
