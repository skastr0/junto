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

/** Build argv that runs `herdr …` on the given host (ssh-wrapped for remotes). */
export const herdrArgv = (
  hostId: string,
  args: ReadonlyArray<string>,
  session?: string | null,
): { readonly command: string; readonly argv: string[] } => {
  const sessionArgs = session ? (["--session", session] as const) : ([] as const);
  const herdrArgs = [...sessionArgs, ...args];
  if (hostId === "local") {
    return { command: "herdr", argv: [...herdrArgs] };
  }
  // Remote: ssh BatchMode + short connect timeout (mirror hermes transport).
  return {
    command: "ssh",
    argv: [
      "-o",
      "ConnectTimeout=6",
      "-o",
      "BatchMode=yes",
      hostId,
      "herdr",
      ...herdrArgs,
    ],
  };
};
