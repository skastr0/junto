import { useEffect, useState } from "react";
import type { TerminalSessionSummary } from "@shared/terminal";
import { getVellumApi } from "../../lib/vellum-api";

export function TerminalInventory() {
  const [sessions, setSessions] = useState<readonly TerminalSessionSummary[]>([]);
  const [open, setOpen] = useState(false);
  const refresh = () => void getVellumApi()?.terminalList?.().then(setSessions);
  useEffect(() => { if (open) refresh(); }, [open]);
  const detached = sessions.filter((session) => session.detached && session.status === "running");
  return <div className="terminal-inventory">
    <button type="button" onClick={() => setOpen((value) => !value)}>terms{detached.length ? ` ${detached.length}` : ""}</button>
    {open ? <section><header>DETACHED SESSIONS <button type="button" onClick={() => setOpen(false)}>×</button></header>
      {detached.length === 0 ? <p>No detached sessions.</p> : detached.map((session) => <div key={session.bindingId}><span>{session.label ?? session.title ?? session.bindingId.slice(0, 12)}</span><small>{session.cwd}</small><button type="button" onClick={() => void getVellumApi()?.terminalKill?.(session.bindingId).then(refresh)}>Kill</button></div>)}
    </section> : null}
  </div>;
}
