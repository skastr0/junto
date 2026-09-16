import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACTOR_KINDS } from "../src/shared/physics";

// The cement for the factory consolidation.
//
// Nine of this migration's invariants are held by the type system and need no
// test — an illegal state does not compile, or cannot be written at all. These
// three cannot be typed, because no type stops an agent from *inventing* a new
// branch or a new word:
//
//   1. a second actor kind appears
//   2. a capability decision switches on entity.kind instead of role
//   3. the retired vocabulary comes back
//
// Each one below must be proven RED against a deliberate violation before it is
// worth anything. See docs/factory-consolidation-plan.md §3.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sourceFiles = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return [".ts", ".tsx"].includes(extname(path)) ? [path] : [];
  });

const display = (path: string): string => relative(root, path);

const filesUnder = (...segments: ReadonlyArray<string>): ReadonlyArray<string> =>
  sourceFiles(join(root, ...segments));

describe("factory physics architecture", () => {
  it("admits exactly one actor kind, and it is `agent`", () => {
    // Construction-level already: ActorKind is a single literal. This asserts
    // the literal itself, so widening it back to a union fails here too.
    expect([...ACTOR_KINDS]).toEqual(["agent"]);
  });

  it("keeps capability decisions on the role, never on entity.kind", () => {
    // Capability planes decide what a caller may DO. They must ask physics for
    // a role (resolveSpec / roleOf / a NodeSpec Match) and never compare a kind
    // string — that is how the ~12 disagreeing kind lists grew last time.
    const planes = [
      ...filesUnder("src", "main", "junto", "work"),
      ...filesUnder("src", "main", "junto", "browser"),
      ...filesUnder("src", "main", "junto", "kernel"),
    ];
    // Capability planes must not branch on canvas entity.kind for the well-known
    // actor/sink kinds. Work-item `.kind` and open-vocab furniture (e.g. board)
    // are outside this probe; ports still go through role/physics.
    const kindComparison =
      /\.entity\?\.kind\s*(?:===|!==)\s*["'`](?:agent|terminal|page|task|requests|artifacts|watcher|timer)["'`]/u;
    const violations = planes.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return kindComparison.test(source) ? [display(path)] : [];
    });
    expect(violations).toEqual([]);
  });

  it("does not resurrect the retired vocabulary", () => {
    // `worker` is RESERVED for the future native agent UI (operator ruling,
    // 2026-07-26). It must not appear as a kind, role, or type until that node
    // is authored deliberately. The rest are words for models this migration
    // deleted; their reappearance means the model came back with them.
    const retired: ReadonlyArray<readonly [RegExp, string]> = [
      [/\bRuntimeTier\b/u, "the tier scale is gone — placement is data, not a permission axis"],
      [/\bPORT_TIER_FLOOR\b|\btierAllowsPort\b/u, "ports are not gated by tier"],
      [
        /["'`](?:tier|facility)["'`]/u,
        "retired tier/facility denial branches must not survive beside geography",
      ],
      [/\bActorClass\b/u, "there is no actor class"],
      [/\brouteToken|RouteToken\b/u, "there is one admission path: process-bind"],
      [/["'`]half-agent["'`]|\bhalfAgent\b/u, "an actor is legal or it is not; there is no half"],
      [/\bdemoteActor\b|["'`]demote["'`]/u, "the decoder never rewrites what a node is"],
      [/\bmanagedAgentKind\b|["'`]managed-agent["'`]/u, "managed-ness is not a kind"],
      [
        /\bmakeAgentNode\b/u,
        "agent construction requires an explicit managed-terminal harness",
      ],
      // Reserved as a KIND, not as a word: a fixture node may still be labelled
      // "worker". What must not appear is worker-as-a-node-kind.
      [
        /kind:\s*["'`]worker["'`]|\bWorkerKind\b|["'`]worker["'`]\s*(?:\||,)\s*["'`](?:agent|terminal)["'`]/u,
        "`worker` is reserved for the future native agent UI",
      ],
    ];
    const self = join(root, "tests", "factory-physics-architecture.test.ts");
    const externalVocabularyReaders = new Set([
      join(root, "src", "main", "junto", "usage", "devin-source.ts"),
      join(root, "src", "main", "junto", "usage", "synthetic-source.ts"),
    ]);
    const files = [...filesUnder("src"), ...filesUnder("tests")].filter(
      (path) => path !== self && !externalVocabularyReaders.has(path),
    );
    const violations = files.flatMap((path) => {
      const source = readFileSync(path, "utf8");
      return retired.flatMap(([pattern, why]) =>
        pattern.test(source) ? [`${display(path)} — ${why}`] : [],
      );
    });
    expect(violations).toEqual([]);
  });

  it("delivers factory claims as a complete CLI briefing on the direct claim path", () => {
    // Direct-claim contract (PTY-Factory A): delivery builds one complete briefing.
    // Do not encode ban-lists of retired symbols here — standing ruling against
    // mistake-tombstone tests; the positive contract is the gate.
    const kernel = readFileSync(
      join(root, "src", "main", "junto", "kernel", "service.ts"),
      "utf8",
    );
    const claimPrompt = readFileSync(
      join(root, "src", "shared", "factory-claim-prompt.ts"),
      "utf8",
    );
    expect(kernel).toContain("buildFactoryClaimPrompt");
    expect(claimPrompt).toContain("[factory claim]");
    expect(claimPrompt).toContain("junto tasks list");
    expect(claimPrompt).toContain("junto tasks update");
    expect(claimPrompt).toContain('"target"');
    expect(claimPrompt).toContain('"task"');
  });

});
