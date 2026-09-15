import { spawnSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Fitness registration for the crew module boundaries added in this iteration.
//
// The single-write-seam register is the canonical guardrail for "one product
// database, one owning writer": every mutation seam, decode boundary and
// database opener is an explicit path with a written reason, and the gate
// refuses anything else. These tests keep the crew additions registered, and
// keep the renderer plane decode-free.

const ROOT = path.resolve(import.meta.dirname, "..");
const REGISTER = path.join(ROOT, "scripts/single-write-seam-register.json");
const GATE = path.join(ROOT, "scripts/lint-single-write-seam.ts");

type SeamEntry = {
  readonly path: string;
  readonly kind: string;
  readonly tables: ReadonlyArray<string>;
  readonly reason: string;
  readonly retire?: string;
};

type DecodeEntry = {
  readonly path: string;
  readonly kinds: ReadonlyArray<string>;
  readonly reason: string;
  readonly retire?: string;
};

type Register = {
  readonly mutationSeams: ReadonlyArray<SeamEntry>;
  readonly sharedTableExceptions: ReadonlyArray<{ readonly table: string }>;
  readonly decodeBoundaries: ReadonlyArray<DecodeEntry>;
};

const register = JSON.parse(readFileSync(REGISTER, "utf8")) as Register;

const CREW_TABLES = [
  "work_mail_attempts",
  "work_review_checkout_observations",
  "work_review_receipts",
  "work_review_verdicts",
] as const;

const crewRepository = "src/main/vellum-command/work/crew-repository.ts";

describe("crew boundaries in the single-write-seam register", () => {
  it("registers the crew repository as the one writer of its four tables", () => {
    const seams = register.mutationSeams.filter((entry) => entry.path === crewRepository);
    expect(seams).toHaveLength(1);
    const seam = seams[0]!;
    expect(seam.kind).toBe("debt");
    expect([...seam.tables].sort()).toEqual([...CREW_TABLES]);
    expect(seam.reason.trim().length).toBeGreaterThan(0);
    // Debt, so the entry must name what removes it.
    expect(seam.retire?.trim().length ?? 0).toBeGreaterThan(0);
  });

  it("keeps every crew table single-writer, with no shared-table exception", () => {
    const writers = register.mutationSeams.filter((entry) =>
      entry.tables.some((table) => (CREW_TABLES as ReadonlyArray<string>).includes(table)),
    );
    expect(writers.map((entry) => entry.path)).toEqual([crewRepository]);
    for (const table of CREW_TABLES) {
      expect(
        register.sharedTableExceptions.filter((entry) => entry.table === table),
        table,
      ).toEqual([]);
    }
  });

  it("registers the crew row decode and the two crew codec boundaries", () => {
    const rows = register.decodeBoundaries.filter((entry) => entry.path === crewRepository);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kinds).toEqual(["row"]);
    // Interior kinds re-parse rows this process wrote, so they must retire.
    expect(rows[0]!.retire?.trim().length ?? 0).toBeGreaterThan(0);

    const mailCodec = register.decodeBoundaries.filter(
      (entry) => entry.path === "src/shared/crew.ts",
    );
    expect(mailCodec).toHaveLength(1);
    expect(mailCodec[0]!.kinds).toEqual(["codec"]);

    const promptWire = register.decodeBoundaries.filter(
      (entry) => entry.path === "src/shared/managed-prompt.ts",
    );
    expect(promptWire).toHaveLength(1);
    expect(promptWire[0]!.kinds).toEqual(["wire"]);
  });

  it("points every crew entry at a file that exists", () => {
    for (const entry of [...register.mutationSeams, ...register.decodeBoundaries]) {
      if (!entry.path.includes("crew") && !entry.path.endsWith("managed-prompt.ts")) continue;
      expect(existsSync(path.join(ROOT, entry.path)), entry.path).toBe(true);
    }
  });

  it("keeps the renderer plane decode-free", () => {
    // No renderer file has ever been a decode boundary: the renderer consumes
    // product-produced values through shared readers and typed projections.
    // A renderer decode re-validates what main already validated, so it is
    // fixed at the source rather than registered here.
    const rendererDecodes = register.decodeBoundaries.filter((entry) =>
      entry.path.startsWith("src/renderer/"),
    );
    expect(rendererDecodes).toEqual([]);
  });

  it("passes the gate itself on the current tree", () => {
    const result = spawnSync("bun", [GATE], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(result.stdout).toMatch(/^ok single-write-seam:/m);
  });
});
