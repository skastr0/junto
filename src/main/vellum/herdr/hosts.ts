// P0 herdr hosts. Easy to extend — discovery is deliberately out of scope.

export interface HerdrHostDef {
  /** Stable product id used in ether.herdr.host and IPC. */
  readonly id: string;
  /** Human label for wizard chrome. */
  readonly label: string;
}

export const HERDR_HOSTS: ReadonlyArray<HerdrHostDef> = [
  { id: "local", label: "local" },
  { id: "remote-a", label: "remote-a" },
] as const;

export const isKnownHerdrHost = (id: string): boolean =>
  HERDR_HOSTS.some((host) => host.id === id);

/** Fixed ssh target for a known remote host id (never pass free hostId to ssh). */
export const sshTargetForHost = (hostId: string): string | undefined => {
  if (hostId === "remote-a") return "remote-a";
  return undefined;
};

export class UnknownHerdrHostError extends Error {
  readonly code = "invalid" as const;
  constructor(hostId: string) {
    super(`unknown herdr host: ${hostId} (P0: local | remote-a)`);
    this.name = "UnknownHerdrHostError";
  }
}

/** Build argv that runs `herdr …` on the given host (ssh-wrapped for remotes). */
export const herdrArgv = (
  hostId: string,
  args: ReadonlyArray<string>,
  session?: string | null,
): { readonly command: string; readonly argv: string[] } => {
  if (!isKnownHerdrHost(hostId) || hostId.startsWith("-")) {
    throw new UnknownHerdrHostError(hostId);
  }
  const sessionArgs = session ? (["--session", session] as const) : ([] as const);
  const herdrArgs = [...sessionArgs, ...args];
  if (hostId === "local") {
    return { command: "herdr", argv: [...herdrArgs] };
  }
  const sshTarget = sshTargetForHost(hostId);
  if (!sshTarget || sshTarget.startsWith("-")) {
    throw new UnknownHerdrHostError(hostId);
  }
  // Remote: ssh BatchMode + keepalives (mirror ACP spawn posture for long streams).
  return {
    command: "ssh",
    argv: [
      "-o",
      "ConnectTimeout=6",
      "-o",
      "BatchMode=yes",
      "-o",
      "ServerAliveInterval=30",
      "-o",
      "ServerAliveCountMax=3",
      sshTarget,
      "herdr",
      ...herdrArgs,
    ],
  };
};
