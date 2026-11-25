/**
 * The confirmedUnreachable transport lock. Only the operator's window may set
 * the marker on a node delete: it enters at Electron main's trusted IPC
 * (assertTrusted), rides the core link once, and is read inside the delete
 * service. Every other reach of a delete — the CLI's overseer delete, the
 * machine-to-machine seats channel — is built field by field or typed
 * without it, and this file keeps it that way in both directions: no carrier
 * outside the four named files, and none at all in the overseer, the seats
 * channel or the native CLI.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const walk = (root: string, suffix: RegExp): ReadonlyArray<string> => {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry !== "node_modules" && !entry.startsWith(".")) visit(path);
      } else if (suffix.test(entry)) {
        out.push(path);
      }
    }
  };
  visit(root);
  return out;
};

const carriers = (root: string, suffix: RegExp): ReadonlyArray<string> =>
  walk(root, suffix).filter((path) => readFileSync(path, "utf8").includes("confirmedUnreachable"));

describe("confirmedUnreachable is the window's alone", () => {
  it("no source file outside the window path, its contract and its service carries the marker", () => {
    // The five: the wire contract the core serves, the mount that names its
    // one transport, the shared IPC type the window decodes, the delete
    // service that reads it, and the window's delete mutation that sets it
    // on the operator's second confirm.
    expect([...carriers("src", /\.tsx?$/)].sort()).toEqual([
      "src/contract/core/term-ipc.ts",
      "src/core/ops/term-ipc.ts",
      "src/core/term/node-delete.ts",
      "src/shared/ipc.ts",
      "src/window/lib/mutations.ts",
    ]);
  });

  it("the native CLI has no surface for the marker at all", () => {
    expect(carriers("native/cli/src", /\.rs$/)).toEqual([]);
  });

  it("the delete service never reads the marker for a caller but the operator's confirm: overseer input is built field by field", () => {
    // The overseer's delete hooks construct each begin resource as an
    // explicit list of bindingId, hostId, canvas, seatId and canvasSeq
    // (overseer/native.ts). A marker on the CLI's input cannot pass a
    // construction that never names it; the scan above keeps the word out
    // of that file, and this reads the construction to prove it is the
    // explicit one.
    const source = readFileSync("src/core/overseer/native.ts", "utf8");
    const begin = source.slice(source.indexOf("beginNodeDelete("), source.indexOf("beginNodeDelete(") + 700);
    expect(begin).toContain("bindingId: resource.bindingId");
    expect(begin).not.toContain("...resource");
    expect(begin).not.toContain("confirmedUnreachable");
  });

  it("the delete's begin has no caller but the four named: a fifth fails whether or not it names the marker", () => {
    // A passthrough caller — beginNodeDelete(args.resources) — never names
    // the field, so the word scan cannot see it. The callers are the closed
    // four: the definition, the mount, main's relay and the overseer.
    const callers = walk("src", /\.tsx?$/).filter((path) => {
      const source = readFileSync(path, "utf8");
      return source.includes("beginNodeDelete(") || source.includes("TermBeginNodeDelete(");
    });
    expect([...callers].sort()).toEqual([
      "src/app/term/ipc.ts",
      "src/core/ops/term-ipc.ts",
      "src/core/overseer/native.ts",
      "src/core/term/node-delete.ts",
    ]);
  });
});

