import { Effect, ManagedRuntime, Result } from "effect";
import { WorkSocket, WorkSocketLive } from "../cli/core/socket";
import { decodeOverseerHostAssignment, type OverseerHostEvent, type OverseerHostRun } from "../shared/overseer-host-control";
import { requestBackendResponse, runOverseerTurn } from "./session";

const title = (state: "idle" | "working" | "attention") =>
  process.stdout.write(`\u001b]0;Vellum Command Overseer ${state}\u0007`);

/** The packaged CLI is the managed occupant itself; no second agent or authority is minted here. */
export const runOverseerHost = async (_args: readonly string[]): Promise<void> => {
  const runtime = ManagedRuntime.make(WorkSocketLive);
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const active = new Map<string, { run: OverseerHostRun; controller: AbortController; done: Promise<void> }>();
  const call = (op: "overseer" | "overseer.live", args: unknown, signal = shutdown.signal) =>
    runtime.runPromise(Effect.flatMap(WorkSocket, (socket) => socket.call(op, args, 25_000)), { signal });
  const report = (run: OverseerHostRun, event: OverseerHostEvent) =>
    call("overseer.live", { type: "event", sessionId: run.sessionId, requestId: run.requestId, intentRevision: run.intentRevision, event }).then(() => undefined);
  process.stdout.write("Vellum Command Overseer is ready. Start a live conversation from its command card.\n");
  title("idle");
  try {
    while (!shutdown.signal.aborted) {
      // Main selects the active session from this process-bound occupant. A
      // previous call's session ID must not strand this host after replacement.
      const result = await call("overseer.live", { type: "next" });
      const decoded = decodeOverseerHostAssignment(result);
      if (Result.isFailure(decoded)) throw new Error("main returned a malformed controller assignment");
      const assignment = decoded.success;
      if (assignment.type === "idle") {
        await runtime.runPromise(Effect.sleep("250 millis"), { signal: shutdown.signal });
        continue;
      }
      if (assignment.type === "cancel") {
        const pending = active.get(assignment.requestId);
        if (pending !== undefined && pending.run.intentRevision <= assignment.intentRevision) pending.controller.abort();
        continue;
      }
      // Only a revision of this request replaces its previous interpretation.
      // Independent requests remain live while a correction is interpreted.
      const previous = active.get(assignment.requestId);
      previous?.controller.abort();
      if (previous !== undefined) await previous.done;
      if (active.size >= 4) throw new Error("main exceeded the controller's four concurrent request limit");
      const controller = new AbortController();
      const onShutdown = () => controller.abort();
      shutdown.signal.addEventListener("abort", onShutdown, { once: true });
      title("working");
      const entry = {
        run: assignment, controller,
        done: runOverseerTurn(assignment, {
          respond: requestBackendResponse,
          tool: (request, signal) => call("overseer", request, signal),
          event: (event) => report(assignment, event),
          control: (request, signal) => call("overseer.live", request, signal),
        }, controller.signal).catch(() => { title("attention"); }).finally(() => {
          shutdown.signal.removeEventListener("abort", onShutdown);
          if (active.get(assignment.requestId) === entry) {
            active.delete(assignment.requestId);
            title(active.size === 0 ? "idle" : "working");
          }
        }),
      };
      active.set(assignment.requestId, entry);
    }
  } catch (error) {
    if (!shutdown.signal.aborted) {
      title("attention");
      process.stderr.write(`${error instanceof Error ? error.message : "Controller connection failed."}\n`);
      process.exitCode = 1;
    }
  } finally {
    shutdown.abort();
    for (const entry of active.values()) entry.controller.abort();
    await Promise.allSettled([...active.values()].map((entry) => entry.done));
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    await runtime.dispose();
  }
};
