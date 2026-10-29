import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { AUTOMATION_WRITE_DESCRIPTIONS, codeFilesOf, overseerAutomationExamples } from "../src/cli/commands/overseer-automation";
import { actionKindInBuild, actionKindRefusal, actionRefusal, answeredWatchRefusal } from "../src/shared/automation";
import { ALL_FEATURES, SHIP_FEATURES } from "../src/shared/feature-catalog";
import { AUTOMATION_SIGNALS_ENABLED, CODE_STEPS_ENABLED, VAULT_ENABLED } from "../src/shared/features";

describe("code steps and the automation signal action (0.11 gates)", () => {
  it("code steps ship off until their walk passes, signals ship on, and all-on carries them", () => {
    expect(SHIP_FEATURES.codeSteps).toBe(false);
    expect(SHIP_FEATURES.automationSignals).toBe(true);
    expect(ALL_FEATURES.codeSteps).toBe(true);
    expect(ALL_FEATURES.automationSignals).toBe(true);
    expect(actionKindInBuild("code")).toBe(CODE_STEPS_ENABLED);
    expect(actionKindInBuild("signal")).toBe(AUTOMATION_SIGNALS_ENABLED);
    expect(actionKindInBuild("mail")).toBe(true);
  });

  it("gate the save every writer passes, the runner, and the editor's step picker", () => {
    expect(readFileSync("src/shared/automation-domain.ts", "utf8")).toContain(
      "const refused = actionKindRefusal(action.kind) ?? actionRefusal(action);",
    );
    expect(readFileSync("src/main/junto/automation/live.ts", "utf8")).toContain(
      "!actionKindInBuild(action.kind) ? Effect.succeed(notAvailable(index))",
    );
    expect(readFileSync("src/renderer/components/automations/AutomationEditor.tsx", "utf8")).toContain(
      "(Object.keys(ACTION_LABEL) as ReadonlyArray<ActionKind>).filter(actionKindInBuild)",
    );
  });

  it("refuses a signal's secret form at save while the vault is not in the build", () => {
    const secret = { kind: "signal", signal: "escalate", title: "Token?", form: { kind: "secret", name: "CLOUDFLARE_API_TOKEN" } } as const;
    expect(actionRefusal(secret as never)).toEqual(
      VAULT_ENABLED
        ? undefined
        : {
            reason: "not_available",
            message: "the secret form arrives with the vault, which is not in this build",
            next_step: "Ask in words or for proof instead, or raise it from a build with the vault",
          },
    );
  });

  describe.runIf(!CODE_STEPS_ENABLED)("with code steps off", () => {
    it("refuses a code step at save, saying why, and the CLI neither says nor stages one", async () => {
      expect(actionKindRefusal("code")).toMatchObject({ reason: "not_available", message: "code steps are off in this build" });
      expect(AUTOMATION_WRITE_DESCRIPTIONS["automation.create"]).not.toContain("code step");
      expect(overseerAutomationExamples.some((one) => JSON.stringify(one).includes('"kind":"code"'))).toBe(false);
      const refused = await Effect.runPromise(Effect.flip(codeFilesOf("automation.create", {
        target: "Automations",
        then: [{ kind: "code", language: "shell", file: "./step.sh" }],
      })));
      expect(refused.message).toContain("code steps are off in this build");
    });
  });

  describe.runIf(!AUTOMATION_SIGNALS_ENABLED)("with automation signals off", () => {
    it("refuses a signal action at save, saying why, and the CLI does not say one", () => {
      expect(actionKindRefusal("signal")).toMatchObject({ reason: "not_available", message: "signals from automations are off in this build" });
      expect(AUTOMATION_WRITE_DESCRIPTIONS["automation.create"]).not.toContain("signal action");
      expect(overseerAutomationExamples.some((one) => JSON.stringify(one).includes('"kind":"signal"'))).toBe(false);
      // An answered watch rides the same gate: nothing it hears is raised.
      expect(answeredWatchRefusal({ kind: "change", on: { kind: "answered", automation: { node: "automations-1", automationId: "01M5ESKJFC1A88R1MH1NEZWJ2Q" } } } as never))
        .toMatchObject({ reason: "not_available", message: "answers to automation signals are off in this build" });
    });
  });
});
