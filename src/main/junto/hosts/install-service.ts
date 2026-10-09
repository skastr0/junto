import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ensureMachineDirectory, ownedMachineFile, removeMachineServiceFile, writeMachineServiceFile } from "./install-paths";

const exec = promisify(execFile);
const run = async (command: string, args: string[]): Promise<string> =>
  (await exec(command, args, { timeout: 30_000, maxBuffer: 256 * 1024 })).stdout;
const xml = (value: string): string => value.replace(/[&<>"']/g, token => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&apos;"}[token]!));
const unit = (value: string): string => '"' + value.replace(/[%\\"\n\r]/g, token => token === '%' ? '%%' : '\\' + token) + '"';

export interface MachineService {
  readonly provider: "launchd" | "systemd-user";
  readonly observe: () => Promise<{ loaded: boolean; pid: number; matchesDesiredPlacement: boolean }>;
  readonly stop: () => Promise<void>;
  readonly start: () => Promise<void>;
  readonly removeDefinition: () => Promise<void>;
}

const exitCode = (cause: unknown): unknown => cause instanceof Error && "code" in cause ? cause.code : undefined;

/** Admission is the exact owned definition plus the loaded job's paths and home. */
export const darwinMachineService = async (
  root: string, home: string, label: string,
  launchctl: (args: string[]) => Promise<string> = args => run("/bin/launchctl", args),
): Promise<MachineService> => {
  const node = join(root, "current/bin/node");
  const entry = join(root, "current/core/junto.cjs");
  const user = `user/${process.getuid!()}`;
  const gui = `gui/${process.getuid!()}`;
  const file = join(homedir(), "Library/LaunchAgents", label + ".plist");
  const body = (session: "Aqua" | "Background") => `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array><key>EnvironmentVariables</key><dict><key>JUNTO_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>LimitLoadToSessionType</key><string>${session}</string><key>StandardOutPath</key><string>${xml(join(root,"logs/stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(join(root,"logs/stderr.log"))}</string></dict></plist>\n`;
  const background = body("Background");
  const aqua = body("Aqua");
  // Select once. Losing the session during activation is a failed start, never
  // permission to hop domains or start a second core.
  let domain: string;
  try { await launchctl(["print", gui]); domain = gui; }
  catch (cause) { if (exitCode(cause) !== 112) throw cause; domain = user; }
  const desired = domain === gui ? aqua : background;
  await ensureMachineDirectory(dirname(file));
  const definition = async (): Promise<string | undefined> => {
    if (!await ownedMachineFile(file)) return undefined;
    const value = await readFile(file, "utf8");
    if (value !== background && value !== aqua) throw new Error("existing service definition belongs to a different install");
    return value;
  };
  await definition();
  type Observed = { domain: string; pid: number; definition: string };
  const snapshot = async (): Promise<Observed | undefined> => {
    const value = await definition();
    const jobs: Observed[] = [];
    for (const candidate of [user, gui]) {
      let output: string;
      try { output = await launchctl(["print", `${candidate}/${label}`]); }
      catch (cause) {
        if (exitCode(cause) === 113 || (candidate === gui && exitCode(cause) === 112)) continue;
        throw cause;
      }
      const lines = output.split("\n").map(line => line.trim());
      const argumentsBlock = /(?:^|\n)\s*arguments = \{\n([\s\S]*?)\n\s*\}/.exec(output);
      const args = argumentsBlock?.[1]?.split("\n").map(line => line.trim()).filter(Boolean);
      if (value === undefined || !lines.includes(`path = ${file}`) || !lines.includes(`program = ${node}`) ||
          !lines.includes(`JUNTO_HOME => ${home}`) || args?.length !== 2 || args[0] !== node || args[1] !== entry) {
        throw new Error("loaded service does not belong to this install");
      }
      const match = /^\s*pid = ([1-9][0-9]*)\s*$/m.exec(output);
      jobs.push({ domain: candidate, pid: match === null ? 0 : Number(match[1]), definition: value });
    }
    if (jobs.length > 1) throw new Error("Junto service is loaded in both macOS sessions; cleanup refused");
    return jobs[0];
  };
  let admitted: Observed | undefined;
  return {
    provider: "launchd",
    observe: async () => {
      admitted = await snapshot();
      return { loaded: admitted !== undefined, pid: admitted?.pid ?? 0,
        matchesDesiredPlacement: admitted?.domain === domain && admitted.definition === desired };
    },
    stop: async () => {
      const current = await snapshot();
      if (current === undefined) return;
      if (admitted === undefined || admitted.domain !== current.domain || admitted.pid !== current.pid || admitted.definition !== current.definition) {
        throw new Error("service changed after admission; stopping refused");
      }
      await launchctl(["bootout", `${current.domain}/${label}`]);
    },
    start: async () => {
      if (await snapshot() !== undefined) throw new Error("Junto service must be quiescent before starting");
      const previous = await definition();
      if (previous !== undefined && previous !== desired) await removeMachineServiceFile(file, previous);
      await writeMachineServiceFile(file, desired);
      await launchctl(["bootstrap", domain, file]);
      await launchctl(["kickstart", `${domain}/${label}`]);
    },
    removeDefinition: async () => {
      if (await snapshot() !== undefined) throw new Error("Junto service must be quiescent before removing its definition");
      const value = await definition();
      if (value !== undefined) await removeMachineServiceFile(file, value);
    },
  };
};

/** Only the install's exact service name and definition can be acted on. */
export const machineService = async (root: string, home: string, label: string): Promise<MachineService> => {
  const node = join(root, "current/bin/node");
  const entry = join(root, "current/core/junto.cjs");
  if (process.platform === "darwin") {
    return darwinMachineService(root, home, label);
  }
  if (process.platform !== "linux") throw new Error("machine services support macOS and Linux");
  const name = label + ".service";
  const file = join(homedir(), ".config/systemd/user", name);
  const body = `[Unit]\nDescription=Junto\nAfter=network.target\n\n[Service]\nType=simple\nExecStart=:${unit(node)} ${unit(entry)}\nEnvironment=${unit('JUNTO_HOME='+home)}\nRestart=on-failure\nRestartSec=2\nTimeoutStopSec=30\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
  await ensureMachineDirectory(dirname(file));
  const existed = await ownedMachineFile(file);
  if (existed && await readFile(file, "utf8") !== body) throw new Error("existing service definition belongs to a different install");
  return {
    provider: "systemd-user",
    observe: async () => {
      const output = await run("/usr/bin/systemctl", ["--user", "show", name, "--property=LoadState,MainPID,FragmentPath,ExecStart"]);
      const fields = Object.fromEntries(output.trim().split("\n").map(line => { const index = line.indexOf("="); return [line.slice(0,index),line.slice(index+1)]; }));
      if (fields.LoadState === "not-found" && fields.MainPID === "0") return { loaded: false, pid: 0, matchesDesiredPlacement: true };
      if (fields.LoadState !== "loaded" || fields.FragmentPath !== file || !fields.ExecStart?.includes(`path=${node} ;`)) throw new Error("loaded service does not belong to this install");
      if (!/^(0|[1-9][0-9]*)$/.test(fields.MainPID ?? "")) throw new Error("service returned an invalid process id");
      return { loaded: true, pid: Number(fields.MainPID), matchesDesiredPlacement: true };
    },
    stop: async () => { await run("/usr/bin/systemctl", ["--user", "stop", name]); },
    start: async () => {
      await writeMachineServiceFile(file, body);
      await run("/usr/bin/systemctl", ["--user", "daemon-reload"]);
      await run("/usr/bin/systemctl", ["--user", "enable", name]);
      await run("/usr/bin/systemctl", ["--user", "start", name]);
    },
    removeDefinition: async () => {
      // Refuse a changed file before asking systemd to alter its links.
      if (await ownedMachineFile(file)) {
        if (await readFile(file, "utf8") !== body) throw new Error("service definition changed; cleanup refused");
        await run("/usr/bin/systemctl", ["--user", "disable", name]);
        await removeMachineServiceFile(file, body);
        await run("/usr/bin/systemctl", ["--user", "daemon-reload"]);
      }
    },
  };
};
