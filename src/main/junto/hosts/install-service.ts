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
  readonly observe: () => Promise<{ loaded: boolean; pid: number }>;
  readonly stop: () => Promise<void>;
  readonly start: () => Promise<void>;
  readonly removeDefinition: () => Promise<void>;
}

/** Only the install's exact service name and definition can be acted on. */
export const machineService = async (root: string, home: string, label: string): Promise<MachineService> => {
  const node = join(root, "current/bin/node");
  const entry = join(root, "current/core/junto.cjs");
  if (process.platform === "darwin") {
    const domain = `user/${process.getuid!()}`;
    const target = `${domain}/${label}`;
    const file = join(homedir(), "Library/LaunchAgents", label + ".plist");
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(entry)}</string></array><key>EnvironmentVariables</key><dict><key>JUNTO_HOME</key><string>${xml(home)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ProcessType</key><string>Background</string><key>LimitLoadToSessionType</key><string>Background</string><key>StandardOutPath</key><string>${xml(join(root,"logs/stdout.log"))}</string><key>StandardErrorPath</key><string>${xml(join(root,"logs/stderr.log"))}</string></dict></plist>\n`;
    await ensureMachineDirectory(dirname(file));
    let definitionPresent = await ownedMachineFile(file);
    if (definitionPresent && await readFile(file, "utf8") !== body) throw new Error("existing service definition belongs to a different install");
    const observe = async () => {
      let output: string;
      try { output = await run("/bin/launchctl", ["print", target]); }
      catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === 113) return { loaded: false, pid: 0 };
        throw cause;
      }
      if (!definitionPresent || !output.split("\n").some(line => line.trim() === `program = ${node}`)) {
        throw new Error("loaded service does not belong to this install");
      }
      const match = /^\s*pid = ([1-9][0-9]*)\s*$/m.exec(output);
      return { loaded: true, pid: match === null ? 0 : Number(match[1]) };
    };
    return {
      provider: "launchd",
      observe,
      stop: async () => { await run("/bin/launchctl", ["bootout", target]); },
      start: async () => {
        await writeMachineServiceFile(file, body);
        definitionPresent = true;
        await run("/bin/launchctl", ["bootstrap", domain, file]);
        await run("/bin/launchctl", ["kickstart", target]);
      },
      removeDefinition: async () => { await removeMachineServiceFile(file, body); },
    };
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
      if (fields.LoadState === "not-found" && fields.MainPID === "0") return { loaded: false, pid: 0 };
      if (fields.LoadState !== "loaded" || fields.FragmentPath !== file || !fields.ExecStart?.includes(`path=${node} ;`)) throw new Error("loaded service does not belong to this install");
      if (!/^(0|[1-9][0-9]*)$/.test(fields.MainPID ?? "")) throw new Error("service returned an invalid process id");
      return { loaded: true, pid: Number(fields.MainPID) };
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
