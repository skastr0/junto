import { useEffect, useState } from "react";
import type { TerminalSessionSummary } from "@shared/terminal";
import { getVellumApi } from "../../lib/vellum-api";
import { Button, Eyebrow } from "../ui";

/**
 * Detached-session inventory — a house popover anchored top-right. Sessions
 * outlive surfaces by design; this is the reaper for the ones the operator
 * forgot.
 */
export function TerminalInventory() {
  const [sessions, setSessions] = useState<readonly TerminalSessionSummary[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => void getVellumApi()?.terminalList?.().then(setSessions);
  useEffect(() => { if (open) refresh(); }, [open]);
  const detached = sessions.filter((session) => session.detached && session.status === "running");
  return (
    <div className="absolute right-3 top-[52px] z-[80]">
      <Button size="sm" variant="chrome" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        terms{detached.length ? ` ${detached.length}` : ""}
      </Button>
      {open ? (
        <section
          aria-label="Detached terminal sessions"
          className="absolute right-0 top-[calc(100%+8px)] w-[330px] rounded-lg border border-stroke bg-raise p-3 shadow-[0_18px_50px_rgba(0,0,0,0.55)] backdrop-blur-md"
        >
          <header className="flex items-center justify-between">
            <Eyebrow tone="steel">detached sessions</Eyebrow>
            <Button size="xs" variant="subtle" onClick={() => setOpen(false)}>×</Button>
          </header>
          {detached.length === 0 ? (
            <p className="mt-3 text-[11px] text-dim">No detached sessions.</p>
          ) : (
            <div className="mt-3 grid gap-1.5 border-t border-stroke pt-3">
              {detached.map((session) => (
                <div key={session.bindingId} className="grid grid-cols-[1fr_auto] items-center gap-x-2">
                  <span className="truncate text-[11px] text-ink">
                    {session.label ?? session.title ?? session.bindingId.slice(0, 12)}
                  </span>
                  <Button
                    size="xs"
                    variant="danger"
                    className="row-span-2"
                    title="Stop the process"
                    aria-label="Stop process"
                    onClick={() => void getVellumApi()?.terminalKill?.(session.bindingId).then(refresh)}
                  >
                    Stop
                  </Button>
                  <small className="truncate text-[10px] text-faint">{session.cwd}</small>
                </div>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </div>
  );
}
