/**
 * macOS privacy (TCC) requests the app under test caused, read from the
 * unified log after the fact with /usr/bin/log (not zsh's `log` builtin).
 *
 * tccd logs each request as several AUTHREQ_* lines joined by one msgID:
 * AUTHREQ_CTX names the service and whether it was a preflight check,
 * AUTHREQ_ATTRIBUTION names the responsible, accessing, and requesting
 * processes, AUTHREQ_RESULT the answer. A request belongs to this run when
 * any attributed process is Junto (com.skastr0.junto*) at a pid this run
 * launched. An agent a seat started carries Junto as its responsible process,
 * so its requests count too. Other Junto instances (an operator's own app)
 * share the bundle id and are only counted.
 */
import { spawnSync } from "node:child_process";
import { basename } from "node:path";

export const JUNTO_BUNDLE_ID = "com.skastr0.junto";
const LOG_BIN = "/usr/bin/log";

export interface TccProcess {
  readonly role: string;
  readonly identifier: string;
  readonly pid: number;
  readonly binary: string;
}

export interface TccRequest {
  readonly msgId: string;
  readonly at: string;
  readonly service?: string;
  /** A preflight only checks the current answer; it cannot prompt. */
  readonly preflight?: boolean;
  readonly authValue?: number;
  readonly authReason?: number;
  readonly processes: ReadonlyArray<TccProcess>;
}

export interface TccCapture {
  readonly requests: ReadonlyArray<TccRequest>;
  /** Junto-attributed requests from pids this run did not launch. */
  readonly otherJunto: number;
  readonly error?: string;
}

/** `log show` wants local wall time. */
const logTime = (date: Date): string => {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
};

const PROCESS = /(\w+)=\{TCCDProcess: identifier=([^,]+), pid=(\d+),[^}]*?binary_path=([^},]+)/g;

export const readTccRequests = (since: Date, until: Date, pids: ReadonlySet<number>): TccCapture => {
  const result = spawnSync(
    LOG_BIN,
    [
      "show",
      "--start",
      logTime(new Date(since.getTime() - 1_000)),
      "--end",
      logTime(new Date(until.getTime() + 1_000)),
      "--predicate",
      'subsystem == "com.apple.TCC" AND eventMessage BEGINSWITH "AUTHREQ_"',
      "--style",
      "ndjson",
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 120_000 },
  );
  if (result.status !== 0) {
    return { requests: [], otherJunto: 0, error: `${LOG_BIN} show exited ${result.status}: ${result.stderr.slice(0, 300)}` };
  }
  interface Acc {
    at: string;
    service?: string;
    preflight?: boolean;
    authValue?: number;
    authReason?: number;
    processes: TccProcess[];
  }
  const byMsg = new Map<string, Acc>();
  for (const line of result.stdout.split("\n")) {
    let event: { timestamp?: string; eventMessage?: string };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    const message = event.eventMessage ?? "";
    const msgId = /msgID=([\d.]+)/.exec(message)?.[1];
    if (!msgId) continue;
    const acc = byMsg.get(msgId) ?? { at: event.timestamp ?? "", processes: [] };
    byMsg.set(msgId, acc);
    if (message.startsWith("AUTHREQ_CTX")) {
      acc.service = /service=(\w+)/.exec(message)?.[1];
      acc.preflight = /preflight=yes/.test(message);
    } else if (message.startsWith("AUTHREQ_ATTRIBUTION")) {
      for (const [, role, identifier, pid, binary] of message.matchAll(PROCESS)) {
        acc.processes.push({ role: role!, identifier: identifier!, pid: Number(pid), binary: binary!.trim() });
      }
    } else if (message.startsWith("AUTHREQ_RESULT")) {
      const value = /authValue=(\d+)/.exec(message)?.[1];
      const reason = /authReason=(\d+)/.exec(message)?.[1];
      if (value !== undefined) acc.authValue = Number(value);
      if (reason !== undefined) acc.authReason = Number(reason);
    }
  }
  const requests: TccRequest[] = [];
  let otherJunto = 0;
  for (const [msgId, acc] of byMsg) {
    const junto = acc.processes.filter((p) => p.identifier.startsWith(JUNTO_BUNDLE_ID));
    if (junto.length === 0) continue;
    if (!junto.some((p) => pids.has(p.pid))) {
      otherJunto += 1;
      continue;
    }
    requests.push({ msgId, ...acc });
  }
  requests.sort((a, b) => a.at.localeCompare(b.at));
  return { requests, otherJunto };
};

/** The process whose access was checked, for a short signature: accessing, else requesting, else responsible. */
export const tccAsker = (request: TccRequest): string => {
  const pick = ["accessing", "requesting", "responsible"]
    .map((role) => request.processes.find((p) => p.role === role))
    .find((p) => p !== undefined);
  return pick ? basename(pick.binary) : "unknown";
};
