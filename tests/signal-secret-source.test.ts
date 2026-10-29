/**
 * Where a secret a signal asks for lives (0.12, N5): the region that declares
 * the name for the machine that must read it, read from the same region stack
 * a seat's environment is built from. Innermost outward, a sealed region cuts
 * everything outside it, a later source in one region wins, and two regions at
 * one depth that both declare the name are ambiguous rather than a guess.
 */
import { describe, expect, it } from "vitest";
import { secretSourceOf } from "../src/main/junto/signals/form-rule";
import { artifacts, canvasOf, region, seat } from "./support/model-nodes";
import { asNodeId } from "../src/shared/physics/schema";
import type { EnvSource } from "../src/shared/model";

const opSource = (id: string, name: string, more: Partial<Extract<EnvSource, { kind: "onepassword" }>> = {}): EnvSource => ({
  id,
  kind: "onepassword",
  name,
  ref: `op://Vault/${name}/field`,
  ...more,
});

const localSource = (id: string, name: string, more: Partial<Extract<EnvSource, { kind: "secret" }>> = {}): EnvSource => ({
  id,
  kind: "secret",
  name,
  secretId: `secret-${id}`,
  ...more,
});

const regionAt = (id: string, frame: { x: number; y: number; width: number; height: number }, sources: ReadonlyArray<EnvSource>, more: { sealed?: boolean } = {}) =>
  region(id, frame, { environment: { ...(more.sealed === true ? { sealed: true } : {}), sources: [...sources] } });

const SEAT = asNodeId("agent");

describe("where a secret a signal asks for lives", () => {
  it("is the innermost region that declares the name for that machine", () => {
    const board = canvasOf(
      [
        seat("agent", { x: 100, y: 100, width: 100, height: 40 }),
        regionAt("outer", { x: 0, y: 0, width: 600, height: 600 }, [opSource("a", "TOKEN")]),
        regionAt("inner", { x: 50, y: 50, width: 300, height: 300 }, [localSource("b", "TOKEN")]),
      ],
      [],
    );
    const found = secretSourceOf(board, SEAT, "mini", "TOKEN");
    expect(found).toMatchObject({ region: { id: "inner" }, sourceId: "b" });
  });

  it("walks outward when the inner region declares nothing, and honors a seal", () => {
    const board = canvasOf(
      [
        seat("agent", { x: 100, y: 100, width: 100, height: 40 }),
        regionAt("outer", { x: 0, y: 0, width: 600, height: 600 }, [opSource("a", "TOKEN")]),
        regionAt("inner", { x: 50, y: 50, width: 300, height: 300 }, [opSource("x", "OTHER")]),
      ],
      [],
    );
    expect(secretSourceOf(board, SEAT, "mini", "TOKEN")).toMatchObject({ region: { id: "outer" }, sourceId: "a" });

    const sealed = canvasOf(
      [
        seat("agent", { x: 100, y: 100, width: 100, height: 40 }),
        regionAt("outer", { x: 0, y: 0, width: 600, height: 600 }, [opSource("a", "TOKEN")]),
        regionAt("inner", { x: 50, y: 50, width: 300, height: 300 }, [opSource("x", "OTHER")], { sealed: true }),
      ],
      [],
    );
    expect(secretSourceOf(sealed, SEAT, "mini", "TOKEN")).toBeUndefined();
  });

  it("reads a source for another machine as no declaration, and the last source of one region as the winner", () => {
    const board = canvasOf(
      [
        seat("agent", { x: 100, y: 100, width: 100, height: 40 }),
        regionAt("forge", { x: 0, y: 0, width: 600, height: 600 }, [
          opSource("elsewhere", "TOKEN", { host: "studio" }),
          opSource("first", "TOKEN"),
          opSource("second", "TOKEN"),
        ]),
      ],
      [],
    );
    expect(secretSourceOf(board, SEAT, "mini", "TOKEN")).toMatchObject({ region: { id: "forge" }, sourceId: "second" });
    expect(secretSourceOf(board, SEAT, "studio", "TOKEN")).toMatchObject({ sourceId: "second" });
  });

  it("says ambiguous when two regions at one depth both declare it, and nothing when none does", () => {
    const board = canvasOf(
      [
        seat("agent", { x: 100, y: 100, width: 100, height: 40 }),
        regionAt("twin-a", { x: 50, y: 50, width: 300, height: 300 }, [opSource("a", "TOKEN")]),
        regionAt("twin-b", { x: 50, y: 50, width: 300, height: 300 }, [opSource("b", "TOKEN")]),
        artifacts("shelf", { x: 400, y: 400, width: 100, height: 40, label: "Shelf" }),
      ],
      [],
    );
    expect(secretSourceOf(board, SEAT, "mini", "TOKEN")).toBe("ambiguous");
    expect(secretSourceOf(board, SEAT, "mini", "NOT_DECLARED")).toBeUndefined();
  });
});
