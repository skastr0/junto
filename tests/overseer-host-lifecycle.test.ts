import { afterEach, expect, it, vi } from "vitest";
import { runOverseerHost } from "../src/overseer-host/main";

const mocks = vi.hoisted(() => ({ call: vi.fn(), turn: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../src/overseer-host/session", () => ({ requestBackendResponse: vi.fn(), runOverseerTurn: mocks.turn }));
vi.mock("../src/cli/core/socket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/cli/core/socket")>();
  const { Effect, Layer } = await import("effect");
  return { ...actual, WorkSocketLive: Layer.succeed(actual.WorkSocket, { call: (op, args) => Effect.sync(() => mocks.call(op, args)) }) };
});
afterEach(() => vi.restoreAllMocks());

it("the existing host picks up a replacement Live session", async () => {
  let stop: (() => void) | undefined;
  vi.spyOn(process, "once").mockImplementation((event, listener) => {
    if (event === "SIGTERM") stop = listener;
    return process;
  });
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const run = (sessionId: string) => ({ type: "run", sessionId, requestId: sessionId, intentRevision: 1,
    model: "test", apiKey: "test", instructions: "Read the canvas", context: "What is here?", operationIds: ["op"] });
  mocks.call.mockReturnValueOnce(run("old-session")).mockReturnValueOnce(run("replacement-session"))
    .mockImplementationOnce(() => { stop!(); return { type: "idle" }; });
  await runOverseerHost([]);
  expect(mocks.turn.mock.calls.map(([run]) => run.sessionId)).toEqual(["old-session", "replacement-session"]);
  expect(mocks.call.mock.calls).toEqual([
    ["overseer.live", { type: "next" }], ["overseer.live", { type: "next" }], ["overseer.live", { type: "next" }],
  ]);
});
