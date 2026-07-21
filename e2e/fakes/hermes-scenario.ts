/**
 * Typed scenario shape + helpers for e2e/fakes/bin/hermes.
 *
 * A scenario is a JSON file pointed at by FAKE_HERMES_SCENARIO: an optional
 * `initialize` result override, an optional `session` (sessionId + available
 * models), an optional `profiles` list (fleet discovery table rows), and an
 * ordered `turns` queue consumed one per `session/prompt` call — the last
 * turn repeats once exhausted.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FakeHermesPermissionOption {
  readonly optionId: string;
  readonly name?: string;
}

export interface FakeHermesPermissionRequest {
  readonly title?: string;
  readonly toolKind?: string;
  readonly options: ReadonlyArray<FakeHermesPermissionOption>;
}

export interface FakeHermesTurn {
  /** Whole-reply text, emitted as one `agent_message_chunk`. Ignored if `chunks` is set. */
  readonly reply?: string;
  /** Emit the reply as several chunks instead of one. */
  readonly chunks?: ReadonlyArray<string>;
  /** Sleep this long before each chunk (simulate streaming latency). */
  readonly delayMs?: number;
  /** Ask permission (agent -> client request) before emitting any reply chunk. */
  readonly requestPermission?: FakeHermesPermissionRequest;
  /** `session/prompt` result.stopReason — defaults to "end_turn". */
  readonly stopReason?: string;
}

export interface FakeHermesProfile {
  readonly name: string;
  readonly model?: string;
  readonly gateway?: string;
}

export interface FakeHermesScenario {
  readonly initialize?: {
    readonly protocolVersion?: number;
    readonly agentCapabilities?: Record<string, unknown>;
    readonly authMethods?: ReadonlyArray<{ readonly id?: string; readonly name?: string }>;
  };
  readonly session?: {
    readonly sessionId?: string;
    readonly models?: ReadonlyArray<{ readonly modelId: string; readonly description?: string }>;
  };
  /** `hermes profile list` rows — defaults to a single "default" profile. */
  readonly profiles?: ReadonlyArray<FakeHermesProfile>;
  readonly turns: ReadonlyArray<FakeHermesTurn>;
}

/** Write a scenario file for FAKE_HERMES_SCENARIO to point at. */
export const writeScenario = async (path: string, scenario: FakeHermesScenario): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(scenario), "utf8");
};

/** A single scripted prompt -> reply round trip — the common case. */
export const oneReplyScenario = (reply: string): FakeHermesScenario => ({
  turns: [{ reply }],
});
