import { mkdtemp, rm } from "node:fs/promises";
import { CODE_STEPS_ENABLED } from "../src/shared/features";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import { coreOpBody } from "../src/main/core-process/ops";
import "../src/main/core-process/ops/ipc-automation";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { codeRefusalOf, codeRulingOf, runCodeStep, type CodeStep, type CodeStepContext } from "../src/main/junto/automation/code-step";
import type { CodeRunRequest } from "../src/main/junto/automation/code-runner";
import { AutomationRepository, makeAutomationRepositoryLive } from "../src/main/junto/automation/repository";
import { makeAutomationRunner, type RunnerPorts } from "../src/main/junto/automation/runner";
import { AUTOMATION_STATE_SCHEMA_SQL } from "../src/main/junto/automation/state-schema";
import type { Fired } from "../src/main/junto/automation/values";
import { firedValue } from "../src/main/junto/automation/values";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import {
  type Action,
  type ActionRuling,
  type Automation,
  type AutomationCodePutResponse,
  type AutomationCodeReadResponse,
  AutomationId,
  type AutomationOp,
  AutomationVersion,
  FiringId,
  lastOutcomeOf,
  resolveValues,
  valueNamesIn,
  valueRefusal,
} from "../src/shared/automation";
import { applyAutomationFact, type AutomationEnv, emptyAutomationState, ruleAutomationCommand, type AutomationState } from "../src/shared/automation-domain";
import { InstallationId } from "../src/shared/installation-id";
import { asNodeId } from "../src/shared/physics/schema";
import type { ResourceActor } from "../src/shared/resource-command";
import type { ActorSeatId } from "../src/shared/actor-seat";
import { ContentRef } from "../src/shared/wire/content-ref";
import { OpId } from "../src/shared/work-ids";

const AUTO = AutomationId.make("01M5ESKJFC1A88R1MH1NEZWJ2Q");
const NODE = asNodeId("automations-1");
const SEAT = asNodeId("agent-a");
const EDITOR = Schema.decodeUnknownSync(InstallationId)("macbook-installation");
const STANDBY = Schema.decodeUnknownSync(InstallationId)("mini-installation");
const source = (digit: string) =>
  Schema.decodeUnknownSync(ContentRef)({ sha256: digit.repeat(64), byteLength: 12, mediaType: "text/plain; charset=utf-8" });
const code = (digit = "a"): CodeStep => ({ kind: "code", language: "typescript", source: source(digit) });
const mail = (text: string): Action => ({ kind: "mail", to: { kind: "seat", nodeId: SEAT }, text });

describe("who a code step's program is by", () => {
  const operator: ResourceActor = { kind: "operator" };
  const overseer: ResourceActor = { kind: "seat", seatId: `seat_${"a".repeat(64)}` as ActorSeatId, nodeId: SEAT };
  const envOn = (rulingInstallation: InstallationId): AutomationEnv => ({
    targetsOf: () => new Set([SEAT]),
    isOverseer: (seat) => seat === SEAT,
    rulingInstallation,
  });
  const ruled = (state: AutomationState, op: AutomationOp, actor: ResourceActor, on: InstallationId): AutomationState => {
    const verdict = ruleAutomationCommand(
      state,
      { opId: OpId.make("01M5ESMJNGY0103BZJ3NYHP5GG"), canvasName: "factory", actor, target: { kind: "automation", nodeId: NODE, itemId: AUTO }, basis: null, after: [], op },
      1_000,
      envOn(on),
    );
    if (verdict.kind !== "apply") throw new Error(verdict.refusal.message);
    return verdict.facts.reduce(applyAutomationFact, state);
  };
  const head = (state: AutomationState) => state.get(AUTO)!.automation;
  const definition = (then: ReadonlyArray<Action>, cron = "0 9 * * *") => ({
    name: "Nightly",
    trigger: { kind: "schedule", cron, timezone: "UTC" } as const,
    then: [...then] as Automation["then"],
    limits: { minIntervalMs: 60_000, maxPerHour: 12 },
  });
  const createdBy = (actor: ResourceActor, on: InstallationId) =>
    ruled(emptyAutomationState(), { kind: "create", automationId: AUTO, enabled: true, definition: definition([code("a"), mail("{{code.count}}")]) }, actor, on);

  it.runIf(CODE_STEPS_ENABLED)("is stamped from the ruling that set it: its actor and the installation that ruled it", () => {
    expect(head(createdBy(overseer, EDITOR)).codeRuling).toEqual({ author: { kind: "seat", seat: SEAT }, installation: EDITOR });
    expect(head(ruled(emptyAutomationState(), { kind: "create", automationId: AUTO, enabled: true, definition: definition([mail("x")]) }, operator, EDITOR)).codeRuling).toBeUndefined();
  });

  it.runIf(CODE_STEPS_ENABLED)("stays when a later edit by another actor, ruled elsewhere, changes only the trigger", () => {
    const state = createdBy(overseer, EDITOR);
    const edited = ruled(state, { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition([code("a"), mail("{{code.count}}")], "0 10 * * *") }, operator, STANDBY);
    expect(head(edited).version).toBe(2);
    expect(head(edited).codeRuling).toEqual({ author: { kind: "seat", seat: SEAT }, installation: EDITOR });
  });

  it.runIf(CODE_STEPS_ENABLED)("is the editor's for new code, and an overseer's whenever an overseer's program stays beside it", () => {
    const state = createdBy(operator, EDITOR);
    const replacedBySeat = ruled(state, { kind: "edit", baseVersion: AutomationVersion.make(1), definition: definition([code("b")]) }, overseer, STANDBY);
    expect(head(replacedBySeat).codeRuling).toEqual({ author: { kind: "seat", seat: SEAT }, installation: STANDBY });
    const joinedByOperator = ruled(replacedBySeat, { kind: "edit", baseVersion: AutomationVersion.make(2), definition: definition([code("b"), code("c")]) }, operator, EDITOR);
    expect(head(joinedByOperator).codeRuling).toEqual({ author: { kind: "seat", seat: SEAT }, installation: STANDBY });
    const gone = ruled(joinedByOperator, { kind: "edit", baseVersion: AutomationVersion.make(3), definition: definition([mail("done")]) }, operator, EDITOR);
    expect(head(gone).codeRuling).toBeUndefined();
  });
});

describe("a code step's run", () => {
  const automation: Automation = {
    automationId: AUTO,
    nodeId: NODE,
    author: { kind: "operator" },
    version: AutomationVersion.make(1),
    name: "Nightly",
    enabled: true,
    codeRuling: { author: { kind: "seat", seat: SEAT }, installation: EDITOR },
    trigger: { kind: "schedule", cron: "0 9 * * *", timezone: "UTC" },
    then: [code()],
    limits: { minIntervalMs: 0, maxPerHour: 60 },
  };
  const context = (over: Partial<CodeStepContext> = {}): CodeStepContext => ({
    canvasName: "factory",
    automation,
    step: code(),
    index: 0,
    firingId: FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ30"),
    at: 1_000,
    cause: "schedule",
    event: null,
    values: { "fired.at": "1970-01-01T00:00:01.000Z" },
    env: { API_KEY: "region-secret" },
    ...over,
  });

  it("asks the runner with the input as data and the default bounds", async () => {
    const asked: Array<CodeRunRequest> = [];
    const runner = {
      runCode: (request: CodeRunRequest) =>
        Effect.sync(() => {
          asked.push(request);
          return { kind: "continue" as const, output: { count: 3 }, durationMs: 12.4 };
        }),
    };
    expect(await Effect.runPromise(runCodeStep(runner, context()))).toEqual({ index: 0, ruling: "continued", output: { count: 3 }, durationMs: 12 });
    expect(asked[0]).toMatchObject({
      canvasName: "factory",
      language: "typescript",
      timeoutMs: 60_000,
      maxOutputBytes: 65_536,
      env: { API_KEY: "region-secret" },
      input: {
        automation: { automationId: AUTO, name: "Nightly", nodeId: NODE },
        firing: { firingId: "01M5ESKJFC1A88R1MH1NEZWJ30", at: 1_000, cause: "schedule" },
        event: null,
        values: { "fired.at": "1970-01-01T00:00:01.000Z" },
      },
    });
  });

  it("is refused not_available with no runner, and not_permitted for code no ruling installation stamped", async () => {
    expect(await Effect.runPromise(runCodeStep(undefined, context()))).toEqual({ index: 0, ruling: "refused", reason: "not_available" });
    const unstamped = { ...automation, codeRuling: { author: { kind: "operator" } } } as Automation;
    const runner = { runCode: () => Effect.die("never asked") };
    expect(await Effect.runPromise(runCodeStep(runner, context({ automation: unstamped })))).toEqual({ index: 0, ruling: "refused", reason: "not_permitted" });
  });

  it("records each answer, bounded, with the log's end only on a failure", () => {
    expect(codeRulingOf(1, { kind: "stop", reason: "  nothing new  ", durationMs: 5 })).toEqual({ index: 1, ruling: "stopped", reason: "nothing new", durationMs: 5 });
    expect(codeRulingOf(1, { kind: "timeout", durationMs: 60_000, logTail: { text: "slow\n", cut: false } })).toEqual({
      index: 1,
      ruling: "failed",
      message: "timeout",
      logTail: "slow",
      durationMs: 60_000,
    });
    const long = codeRulingOf(1, { kind: "fail", message: "x".repeat(900), exitCode: 2, durationMs: 1, logTail: { text: "y".repeat(5_000), cut: true } });
    expect(long).toMatchObject({ ruling: "failed", exitCode: 2 });
    if (long.ruling !== "failed") throw new Error("not failed");
    expect(long.message).toHaveLength(500);
    expect(long.logTail).toHaveLength(4_096);
    expect(codeRefusalOf(0, { _tag: "CodeNotPermitted", check: "digest", machine: "mini", canvasName: "factory", message: "no" } as never)).toEqual({
      index: 0,
      ruling: "refused",
      reason: "not_permitted",
    });
  });
});

describe("a firing with a code step", () => {
  const firingOf = async (answer: ActionRuling | ((index: number) => ActionRuling), then: Automation["then"]) => {
    const database = new DatabaseSync(":memory:");
    database.exec(AUTOMATION_STATE_SCHEMA_SQL);
    const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
    const runtime = ManagedRuntime.make(makeAutomationRepositoryLive().pipe(Layer.provideMerge(sql)));
    const said: Array<string> = [];
    const ports: RunnerPorts = {
      // The operator's automation reaches the seat beside it in one region.
      canvas: () =>
        ({
          nodes: new Map([
            ["region", { kind: "region", id: "region", x: 0, y: 0, width: 400, height: 400, z: 0 }],
            [NODE, { kind: "automations", id: NODE, x: 10, y: 10, width: 10, height: 10, z: 0 }],
            [SEAT, { kind: "agent", id: SEAT, x: 100, y: 100, width: 10, height: 10, z: 0 }],
          ]),
          wires: new Map(),
        }) as never,
      holds: () => true,
      perform: (_canvas, _automation, action, index, _firingId, fired: Fired) =>
        Effect.sync(() => {
          if (action.kind === "code") return typeof answer === "function" ? answer(index) : answer;
          if (action.kind === "mail") said.push(resolveValues(action.text, (name) => firedValue(name, fired, {}, undefined, "factory") ?? `{{${name}}}`));
          return { index, ruling: "applied" as const };
        }),
      mintFiringId: () => FiringId.make("01M5ESKJFC1A88R1MH1NEZWJ31"),
      now: () => 5_000,
      runsHere: () => true,
    };
    const seed: Automation = {
      automationId: AUTO,
      nodeId: NODE,
      author: { kind: "operator" },
      version: AutomationVersion.make(1),
      name: "Nightly",
      enabled: true,
      trigger: { kind: "poll", everyMs: 60_000 },
      then,
      limits: { minIntervalMs: 0, maxPerHour: 60 },
    };
    try {
      const firing = await runtime.runPromise(
        Effect.gen(function* () {
          yield* (yield* AutomationRepository).applyFacts("factory", [{ fact: "automation.created", automation: seed, at: 0 }]);
          return yield* makeAutomationRunner(ports).onRun("factory", AUTO);
        }),
      );
      if (firing?.outcome.kind === "skipped") throw new Error(`skipped: ${firing.outcome.reason}`);
      return { firing: firing!, said };
    } finally {
      await runtime.dispose();
      database.close();
    }
  };

  it("hands what it answered to the steps after it as {{code.<field>}}", async () => {
    const { firing, said } = await firingOf({ index: 0, ruling: "continued", output: { count: 3, exit_code: 0 }, durationMs: 4 }, [
      code(),
      mail("{{code.count}} new, exit {{code.exit_code}}, {{code.missing}}"),
    ]);
    expect(said).toEqual(["3 new, exit 0, {{code.missing}}"]);
    expect(firing.outcome).toEqual({
      kind: "fired",
      actions: [{ index: 0, ruling: "continued", output: { count: 3, exit_code: 0 }, durationMs: 4 }, { index: 1, ruling: "applied" }],
    });
  });

  it("runs no later step once a code step stops or fails, and only a failure fails the firing", async () => {
    const stopped = await firingOf({ index: 0, ruling: "stopped", durationMs: 1 }, [code(), mail("never")]);
    expect(stopped.said).toEqual([]);
    expect(lastOutcomeOf(stopped.firing.outcome)).toBe("fired");
    const failed = await firingOf({ index: 0, ruling: "failed", message: "timeout", durationMs: 60_000 }, [code(), mail("never")]);
    expect(failed.said).toEqual([]);
    expect(lastOutcomeOf(failed.firing.outcome)).toBe("failed");
  });
});

describe("code values", () => {
  it("reads {{code.<field>}} with digits and underscores as a value", () => {
    expect(valueNamesIn("{{code.exit_code}} {{code.count2}} {{code.Bad}}")).toEqual(["code.exit_code", "code.count2"]);
  });

  it("are carried only after a code step", () => {
    const trigger = { kind: "poll", everyMs: 60_000 } as const;
    expect(valueRefusal({ trigger, then: [code(), mail("{{code.count}}")] })).toBeUndefined();
    expect(valueRefusal({ trigger, then: [mail("{{code.count}}"), code()] })).toMatchObject({
      reason: "invalid_input",
      message: "no code step before this one answers {{code.count}}",
    });
  });
});

describe("the editor's code channels", () => {
  it("puts a program as text and reads the same text back by its ref; a ref this machine lacks is not_available", async () => {
    const dir = await mkdtemp(join(tmpdir(), "junto-automation-code-"));
    const runtime = ManagedRuntime.make(
      makeContentServiceLive({ root: join(dir, "content"), skipInlineMediaMigration: true }).pipe(
        Layer.provideMerge(Layer.mergeAll(makeStateEngineLive(join(dir, "junto.db")), makeInstallOpsLive(join(dir, "install-ops.db")))),
      ),
    );
    try {
      // The pane's client: both channels are the core operation of that name.
      const call = <A>(name: string, input: unknown): Promise<A> => {
        const body = coreOpBody(name);
        if (body === undefined) throw new Error(`no core operation named ${name}`);
        return runtime.runPromise(body(input as never) as Effect.Effect<A, never, never>);
      };
      const handlers = {
        codePut: (canvasName: unknown, input: unknown) =>
          call<AutomationCodePutResponse>("ipc.automation.codePut", { canvasName, input }),
        codeRead: (canvasName: unknown, input: unknown) =>
          call<AutomationCodeReadResponse>("ipc.automation.codeRead", { canvasName, input }),
      };
      const text = 'import { cont } from "junto/automation";\ncont({ count: 3 });\n';
      const put = await handlers.codePut("factory", { text });
      if (put.kind !== "put") throw new Error(put.refusal.message);
      expect(put.ref.byteLength).toBe(new TextEncoder().encode(text).byteLength);
      expect(await handlers.codeRead("factory", { ref: put.ref })).toEqual({ kind: "read", text });
      expect(await handlers.codeRead("factory", { ref: source("f") })).toMatchObject({ kind: "refused", refusal: { reason: "not_available" } });
      await expect(handlers.codePut("factory", { text: "" })).rejects.toThrow();
    } finally {
      await runtime.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
