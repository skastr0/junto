import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type { LocalHostEvent } from "../local-host";
import { isLiveClaudeResumeSummaryChoice } from "./claude-startup";

/**
 * Claude's resume-summary selector: its highlighted first option is Claude's
 * own recommended recovery, accepted at most once per PTY generation, through
 * the drive so a bare CR never submits a stuck chip. Every core runs this: on
 * a machine with no window, nobody else can answer the selector, and the seat
 * would sit at it for good.
 */
export const watchClaudeResumeRecovery = (deps: {
  readonly suspended: () => boolean;
  readonly subscribeSeatState: (listener: (event: AgentSeatStateEvent) => void) => () => void;
  readonly subscribeSessions: (listener: (payload: LocalHostEvent) => void) => () => void;
  readonly harnessOf: (bindingId: string) => string | undefined;
  readonly session: (bindingId: string) => { readonly status: string; readonly epoch?: string } | undefined;
  readonly screen: (bindingId: string) => { readonly lines: readonly string[] } | undefined;
  readonly submitRecoveryCr: (bindingId: string) => Promise<boolean>;
}): (() => void) => {
  const accepted = new Map<string, string>();
  const stopSessions = deps.subscribeSessions((payload) => {
    if (payload.type !== "session") return;
    accepted.delete(payload.bindingId);
  });
  const stopSeatState = deps.subscribeSeatState((event) => {
    if (event.state !== "attention" || deps.suspended() || deps.harnessOf(event.bindingId) !== "claude") return;
    const live = deps.session(event.bindingId);
    const epoch = live?.epoch;
    const screen = deps.screen(event.bindingId);
    if (live?.status !== "running" || !epoch || !screen || accepted.get(event.bindingId) === epoch) return;
    if (!isLiveClaudeResumeSummaryChoice(screen.lines)) return;
    accepted.set(event.bindingId, epoch);
    void deps.submitRecoveryCr(event.bindingId).then((ok) => {
      if (!ok) accepted.delete(event.bindingId);
    });
  });
  return () => {
    stopSessions();
    stopSeatState();
  };
};
