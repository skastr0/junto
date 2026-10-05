/**
 * Nothing is sent at session start. For every managed harness the resolved
 * launch is argv, cwd and env only: no Junto instructions by flag, agent
 * file, rules directory or argv prompt, and nothing left to type as a first
 * message. That holds for a connected seat and an unconnected one, on a fresh
 * launch and on a resume.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  resolveManagedLaunchPlan,
  type ManagedLaunchChoices,
} from "../src/shared/managed-terminal-launch";
import {
  HARNESS_IDS,
  templateFor,
  type HarnessId,
} from "../src/shared/managed-terminal-templates";
import {
  launchForManagedSpawn,
  launchForManagedSpawnIntent,
  makeManagedSpawnIntent,
  planFreshManagedSpawnIntent,
  planManagedSpawn,
} from "../src/main/junto/term/managed-spawn-plan";
import { seatGuidanceIndex } from "../src/main/junto/seat-guidance/index-memory";

const SESSION = "11111111-2222-4333-8444-555555555555";
const REGION_BRIEFING = "REGION-BRIEFING-CANARY ship the region";
const SEAT_SOUL = "SEAT-SOUL-CANARY you are terse";
const SEAT_INSTRUCTIONS = "SEAT-INSTRUCTIONS-CANARY always run the gate";
const OPERATOR_PROMPT = "OPERATOR-PROMPT-CANARY fix the flaky test";

/** Flags a harness offers for instructions. Junto emits none of them. */
const CARRIER_FLAGS: readonly string[] = [
  "--append-system-prompt",
  "--system-prompt",
  "--system-prompt-snapshot",
  "--rules",
  "--agent",
  "--agent-file",
  "--agents",
  "--add-dir",
  "--instructions",
];

const doc = (harness: HarnessId, connected: boolean): CanvasDoc => ({
  nodes: [
    {
      id: "region",
      type: "group",
      x: -50,
      y: -50,
      width: 600,
      height: 400,
      ether: { region: { instruction: REGION_BRIEFING } },
    },
    {
      id: "worker",
      type: "text",
      text: harness,
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "agent", name: `local:${harness}` },
        terminal: {
          bindingId: "bind-1",
          harness,
          launch: { kind: "harness", argv: [templateFor(harness).argvSpec.binary] },
        },
      },
    },
    {
      id: "peer",
      type: "text",
      text: "codex",
      x: 200,
      y: 0,
      width: 100,
      height: 80,
      ether: { entity: { kind: "agent", name: "local:codex" } },
    },
  ],
  edges: connected
    ? [{ id: "e1", fromNode: "worker", toNode: "peer", ether: { verb: "messages" } }]
    : [],
});

/**
 * Every token of a launch that carries nothing is short and is not prose.
 * Session ids and model names fit; a doctrine body or a nudge sentence cannot.
 */
const expectNoDoctrine = (
  harness: HarnessId,
  plan: { readonly launch?: { readonly argv?: readonly string[]; readonly env?: Readonly<Record<string, string>> } } | undefined,
): void => {
  expect(plan, harness).toBeDefined();
  // The plan is the launch and nothing else: no injection disposition, no
  // message for a drive to type later.
  expect(Object.keys(plan!), harness).toEqual(["launch"]);
  const argv = plan!.launch?.argv ?? [];
  expect(argv.length, harness).toBeGreaterThan(0);
  for (const token of argv) {
    expect(CARRIER_FLAGS, `${harness}: ${token}`).not.toContain(token);
    expect(token, harness).not.toMatch(/\s/);
    expect(token.length, `${harness}: ${token}`).toBeLessThan(64);
    expect(token.toLowerCase(), harness).not.toContain("onboard");
    expect(token, harness).not.toContain("CANARY");
  }
  // The template's prompt slot stays empty unless the operator filled it.
  expect(argv, harness).not.toContain("-q");
  expect(argv, harness).not.toContain("-i");
  expect(argv, harness).not.toContain("--");
  const serialized = JSON.stringify(plan);
  for (const canary of [REGION_BRIEFING, SEAT_SOUL, SEAT_INSTRUCTIONS]) {
    expect(serialized, harness).not.toContain(canary);
  }
  expect(serialized, harness).not.toContain("firstTypedMessage");
};

const provisioned = (harness: HarnessId): boolean =>
  templateFor(harness).capabilityBadges.sessionId === "provision";

afterEach(() => {
  seatGuidanceIndex.note("worker", null);
});

describe("a managed launch carries no Junto instructions", () => {
  it("covers every harness template", () => {
    expect(HARNESS_IDS.length).toBeGreaterThan(10);
  });

  describe.each(HARNESS_IDS.map((harness) => [harness] as const))(
    "%s",
    (harness) => {
      const env = { HOME: "/home/op", PATH: "/usr/bin" };

      it("the template declares no instruction carrier", () => {
        const template = templateFor(harness) as unknown as Record<string, unknown>;
        expect(template).not.toHaveProperty("injectionSpec");
        const argvSpec = template.argvSpec as Record<string, unknown>;
        for (const key of [
          "systemPromptFlag",
          "agentFlag",
          "rulesDirFlag",
          "resumeReinjection",
          "resumeReinjectionArgv",
        ]) {
          expect(argvSpec, key).not.toHaveProperty(key);
        }
        expect(template.capabilityBadges).not.toHaveProperty("instructionInjection");
      });

      it("resolver: fresh launch", () => {
        expectNoDoctrine(
          harness,
          resolveManagedLaunchPlan(harness, { sessionId: SESSION, cwd: "/w" }, env),
        );
        expectNoDoctrine(harness, resolveManagedLaunchPlan(harness, {}, env));
      });

      it("resolver: resume launch", () => {
        const plan = resolveManagedLaunchPlan(
          harness,
          { resumeId: SESSION, model: "m", cwd: "/w" },
          env,
        );
        expectNoDoctrine(harness, plan);
      });

      it("resolver: ignores the old doctrine choices if a caller still passes them", () => {
        const stale = {
          sessionId: SESSION,
          systemPrompt: SEAT_INSTRUCTIONS,
          agentFile: "/tmp/agent.md",
          rulesDir: "/tmp/rules",
          injection: {
            seatBound: true,
            connected: true,
            seatRef: "worker",
            regionInstruction: REGION_BRIEFING,
            seatSoul: SEAT_SOUL,
            seatInstructions: SEAT_INSTRUCTIONS,
          },
        } as unknown as ManagedLaunchChoices;
        const plan = resolveManagedLaunchPlan(harness, stale, env);
        expectNoDoctrine(harness, plan);
        expect(plan.launch.argv).toEqual(
          resolveManagedLaunchPlan(harness, { sessionId: SESSION }, env).launch.argv,
        );
      });

      it("an operator-supplied prompt is the only prompt a launch carries", () => {
        const bare = resolveManagedLaunchPlan(harness, { sessionId: SESSION }, env)
          .launch.argv!;
        const prompted = resolveManagedLaunchPlan(
          harness,
          { sessionId: SESSION, prompt: OPERATOR_PROMPT },
          env,
        ).launch.argv!;
        const spec = templateFor(harness).argvSpec;
        if (spec.promptMode === "none") {
          expect(prompted).toEqual(bare);
          return;
        }
        expect(prompted[prompted.length - 1]).toBe(OPERATOR_PROMPT);
        const slot =
          spec.promptMode === "flag-q"
            ? ["-q"]
            : spec.promptMode === "flag-i"
              ? ["-i"]
              : spec.promptSeparator
                ? [spec.promptSeparator]
                : [];
        expect(prompted).toEqual([...bare, ...slot, OPERATOR_PROMPT]);
      });

      describe.each([
        ["connected", true],
        ["unconnected", false],
      ] as const)("spawn planner, %s seat", (_label, connected) => {
        const input = (resume: boolean) => {
          seatGuidanceIndex.note("worker", {
            soul: SEAT_SOUL,
            instructions: SEAT_INSTRUCTIONS,
          });
          return {
            doc: doc(harness, connected),
            nodeId: "worker",
            harness,
            documentLaunch: {
              kind: "harness" as const,
              argv: [templateFor(harness).argvSpec.binary],
            },
            sessionId: SESSION,
            resume,
          };
        };

        it("fresh", () => {
          expectNoDoctrine(harness, planManagedSpawn(input(false)));
          const finalized = launchForManagedSpawn(input(false));
          expect(finalized.launch).toEqual(finalized.plan?.launch);
          expectNoDoctrine(harness, finalized.plan);
        });

        it("resume", () => {
          expectNoDoctrine(harness, planManagedSpawn(input(true)));
          expectNoDoctrine(harness, launchForManagedSpawn(input(true)).plan);
        });

        it("the spawn intent sent to a process host holds no seat context", () => {
          for (const resume of [false, true]) {
            const intent = makeManagedSpawnIntent(input(resume));
            expect(intent).not.toHaveProperty("injection");
            const wire = JSON.stringify(intent);
            for (const canary of [REGION_BRIEFING, SEAT_SOUL, SEAT_INSTRUCTIONS]) {
              expect(wire).not.toContain(canary);
            }
            const actor = { harness, agentKey: `local:${harness}` };
            expectNoDoctrine(harness, launchForManagedSpawnIntent(actor, intent).plan);
            expectNoDoctrine(
              harness,
              planFreshManagedSpawnIntent(actor, intent, SESSION),
            );
          }
        });
      });

      it("a connected seat and an unconnected seat launch identically", () => {
        const argvFor = (connected: boolean, resume: boolean) =>
          planManagedSpawn({
            doc: doc(harness, connected),
            nodeId: "worker",
            harness,
            sessionId: SESSION,
            resume,
          })?.launch.argv;
        expect(argvFor(true, false)).toEqual(argvFor(false, false));
        expect(argvFor(true, true)).toEqual(argvFor(false, true));
        if (provisioned(harness)) {
          expect(argvFor(true, false)).toContain(SESSION);
        }
      });
    },
  );
});

describe("no session-start carrier survives in the source tree", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx)$/.test(name) ? [path] : [];
    });

  it("nothing arms, plans or types a first message", () => {
    const banned =
      /firstTypedMessage|armFirstTypedMessage|FirstTypedKick|planManagedInjection|writeAgentFileSpec|writeAgentRulesDir|injectionSpec|resumeReinjection/;
    const offenders = sourceFiles(join(__dirname, "..", "src")).filter((path) =>
      banned.test(readFileSync(path, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
