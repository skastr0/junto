import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { overseerRouteOf } from "../src/main/junto/overseer/dispatch";
import { OVERSEER_OPERATION_NAMES, OVERSEER_RETIRED_OPERATIONS } from "../src/shared/overseer-control";

// Where each overseer operation goes once it is admitted. A family renamed in
// the catalog and not in the dispatcher's list is sent to the native adapter,
// which refuses it; every spec that reached the same handler another way
// stayed green while the direct command was dead. This walks the catalog.

const canvasSource = readFileSync(resolve(__dirname, "../src/main/junto/overseer/canvas.ts"), "utf8");
const nativeSource = readFileSync(resolve(__dirname, "../src/main/junto/overseer/native.ts"), "utf8");
const workSource = readFileSync(resolve(__dirname, "../src/main/junto/overseer/work.ts"), "utf8");

/** Whether a handler file names the operation as one it answers. */
const answers = (source: string, operation: string): boolean => source.includes(`"${operation}"`);

describe("overseer operation routing", () => {
  it("sends every canvas, node, wire, sheet and env operation to the canvas handlers", () => {
    const structural = OVERSEER_OPERATION_NAMES.filter((operation) =>
      /^(canvas|node|wire|sheet|env)\./u.test(operation),
    );
    expect(structural.length).toBeGreaterThan(25);
    for (const operation of structural) {
      // A screenshot is taken by the window; a report on an environment is
      // produced by its resolver before routing.
      if (operation === "canvas.screenshot") {
        expect(overseerRouteOf(operation), operation).toBe("native");
        continue;
      }
      expect(overseerRouteOf(operation), operation).toBe("canvas");
    }
  });

  it("routes each operation to a handler file that names it", () => {
    const unanswered: string[] = [];
    for (const operation of OVERSEER_OPERATION_NAMES) {
      const route = overseerRouteOf(operation);
      const source = route === "canvas" ? canvasSource : route === "work" ? workSource : nativeSource;
      if (!answers(source, operation)) unanswered.push(`${operation} -> ${route}`);
    }
    // Answered before routing, in the dispatcher itself: status, the
    // environment report, secrets, references, briefings, and offboard.
    const answeredEarlier = (entry: string): boolean =>
      /^(status|env\.doctor|env\.report|secret\.|references\.|briefing\.|agent\.offboard)/u.test(entry);
    expect(unanswered.filter((entry) => !answeredEarlier(entry))).toEqual([]);
  });

  it("routes no retired name anywhere but to the refusal", () => {
    for (const retired of Object.keys(OVERSEER_RETIRED_OPERATIONS)) {
      expect(overseerRouteOf(retired), retired).toBe("native");
      expect(answers(canvasSource, retired), retired).toBe(false);
    }
  });
});
