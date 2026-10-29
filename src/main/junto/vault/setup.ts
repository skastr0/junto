/**
 * Placing a vault token (docs/machines.md, The vault), from the window's
 * machine. The window's own token writes the vault (read_items and
 * write_items); every other machine's only reads (read_items).
 *
 * `place` runs here, on the owner's call: the token arrives on the owner
 * socket from `junto machine vault-token`'s stdin. For this machine it is
 * written here; for another, it goes over the operator's route on SSH stdin
 * to that machine's `junto machine vault-token-local`, which writes it and
 * records it through its own core (`record`). Either way this machine keeps
 * the names-only record of every token it handed out. Nothing keeps the
 * token but the 0600 file on the machine it is for.
 *
 * Pasted in, the scope is the operator's word, shown unverified. Minted
 * (`--mint`), this core runs the one fixed `op service-account create` under
 * the operator's own 1Password session: the one vault, `read_items`, or
 * `read_items,write_items` for the window's machine, never
 * `--can-create-vaults`. That argv is the proof of scope, recorded as names
 * (the account, the vault, the permissions), and shown verified.
 */
import { Effect, Schema } from "effect";
import { VAULT_ENABLED } from "@shared/features";
import { OperatorErrorBody } from "@shared/operator-control";
import { RemoteHostsError } from "@shared/remote-hosts";
import {
  MachineVaultTokenData, VaultName, VaultTokenSecret, vaultView,
  type MachineVaultRecordInput, type MachineVaultTokenInput, type VaultLiveness, type VaultPermissions, type VaultTokenOrigin,
} from "@shared/vault";
import { registerKnownSecrets, releaseKnownSecrets } from "../credentials/scrub";
import { MachineRepository } from "../machines/repository";
import { HostsService } from "../hosts/service";
import { parseHostSshRoute, SshTransport } from "../ssh";
import { makeRemoteStdin, SshExitError } from "../ssh/domain";
import { placeVaultToken } from "../ssh/machine-commands";
import type { ToolRunner } from "../region-env/tool";
import { opServiceAccountEnv } from "../region-env/sources";
import { makeVaultTokens } from "./repository";
import { readVaultToken, writeVaultToken } from "./token-file";

export interface VaultSetupOptions {
  readonly home: string;
  /** The operator's home, op's HOME. */
  readonly userHome: string;
  readonly run: ToolRunner;
  /** The app's resolved environment, where the operator's own 1Password session is reached. */
  readonly toolEnv: () => Promise<Readonly<Record<string, string | undefined>>>;
  readonly now?: () => number;
}

const refused = (message: string) => new RemoteHostsError("conflict", message);
const off = () => refused("The vault is not in this build");

const WRITE: VaultPermissions = "read_items,write_items";
const READ: VaultPermissions = "read_items";
const VAULT_GET_MS = 15_000;
/** A mint may wait on the operator approving it in the 1Password app. */
export const MINT_MS = 120_000;

/**
 * The one create argv. The vault name is checked again here, since it goes
 * inside `--vault <name>:<permissions>`, where a `:` or `,` would add
 * permissions or vaults.
 */
export const mintArgv = (account: string, vault: string, permissions: VaultPermissions): ReadonlyArray<string> | undefined =>
  Schema.is(VaultName)(vault) ? ["service-account", "create", account, "--vault", `${vault}:${permissions}`, "--raw"] : undefined;

/** The operator's session, never a service account or Connect: those would mint as someone else, or not at all. */
const sessionEnv = (base: Readonly<Record<string, string | undefined>>): Record<string, string | undefined> => {
  const env = { ...base };
  delete env.OP_SERVICE_ACCOUNT_TOKEN;
  delete env.OP_CONNECT_HOST;
  delete env.OP_CONNECT_TOKEN;
  return env;
};

/**
 * Can this machine's token reach the vault now: `op vault get` on that one
 * vault, a liveness check and never proof of scope. `op vault list` showing
 * more than the one vault is a best-effort warning. op's stderr is read for
 * classification only and never returned.
 */
export const vaultLiveness = async (
  options: Pick<VaultSetupOptions, "home" | "userHome" | "run" | "toolEnv">,
  vault: string,
): Promise<{ readonly liveness: VaultLiveness; readonly seesOtherVaults?: true }> => {
  const token = await readVaultToken(options.home).catch(() => undefined);
  if (token === undefined) return { liveness: "no-token" };
  const env = opServiceAccountEnv(token, (await options.toolEnv()).PATH, options.userHome);
  const got = await options.run({ command: "op", args: ["vault", "get", vault, "--format", "json"], timeoutMs: VAULT_GET_MS, env, purpose: "check the vault token" });
  if (got.kind === "not-installed") return { liveness: "op-missing" };
  if (got.kind !== "ok") {
    const said = got.kind === "exit" ? got.stderr.toLowerCase() : "";
    if (/isn't a vault|is not a vault|not found|no vault|doesn't exist/u.test(said)) return { liveness: "vault-missing" };
    if (/token|unauthori[sz]ed|authentication|invalid|forbidden/u.test(said)) return { liveness: "token-refused" };
    return { liveness: "unreachable" };
  }
  const listed = await options.run({ command: "op", args: ["vault", "list", "--format", "json"], timeoutMs: VAULT_GET_MS, env, purpose: "check the vault token" });
  if (listed.kind !== "ok") return { liveness: "ready" };
  try {
    const vaults = JSON.parse(listed.stdout) as unknown;
    return Array.isArray(vaults) && vaults.length > 1 ? { liveness: "ready", seesOtherVaults: true } : { liveness: "ready" };
  } catch {
    return { liveness: "ready" };
  }
};

export const makeVaultSetup = (options: VaultSetupOptions) => Effect.gen(function* () {
  const machines = yield* MachineRepository;
  const hosts = yield* HostsService;
  const ssh = yield* SshTransport;
  const tokens = yield* makeVaultTokens;
  const now = options.now ?? Date.now;

  /** This machine's record and what its token reaches, after its file is in place. */
  const recordHere = (input: { readonly vault: string; readonly permissions: VaultPermissions; readonly origin: VaultTokenOrigin; readonly accountName?: string }) => Effect.gen(function* () {
    const machineName = yield* machines.machineName;
    const record = yield* tokens.put({ machineName, vault: input.vault, permissions: input.permissions, origin: input.origin,
      ...(input.accountName === undefined ? {} : { accountName: input.accountName }), setAtEpochMs: now() });
    const checked = yield* Effect.promise(() => vaultLiveness(options, input.vault));
    return { machineName, token: vaultView(record, now()), ...checked } satisfies MachineVaultTokenData;
  });

  /**
   * The fixed create, under the operator's own session; the token is parsed
   * from stdout in memory and known to the scrub at once. stderr only
   * classifies the refusal.
   */
  const mint = (owner: string, account: string, vault: string, permissions: VaultPermissions) => Effect.gen(function* () {
    const args = mintArgv(account, vault, permissions);
    if (args === undefined) return yield* Effect.fail(refused("A vault name holds no : , / or control character"));
    const env = sessionEnv(yield* Effect.promise(() => options.toolEnv()));
    const result = yield* Effect.promise(() => options.run({ command: "op", args, timeoutMs: MINT_MS, env, purpose: "mint a vault token" }));
    if (result.kind === "ok") {
      const token = Schema.decodeUnknownResult(VaultTokenSecret)(result.stdout.trim());
      if (token._tag === "Success") { registerKnownSecrets(owner, [token.success]); return token.success; }
      registerKnownSecrets(owner, [result.stdout.trim()]);
      return yield* Effect.fail(refused(`1Password answered the mint with no service account token; check for ${account} in 1Password`));
    }
    if (result.kind === "not-installed") return yield* Effect.fail(refused("The 1Password CLI (op) is not installed on this machine"));
    if (result.kind === "timeout") return yield* Effect.fail(refused("1Password did not answer in time; it may be waiting for you to approve the mint"));
    const said = result.kind === "exit" ? result.stderr.toLowerCase() : "";
    if (/not (currently )?signed in|sign in|unlock|session expired|authoriz/u.test(said)) return yield* Effect.fail(refused("Sign in to 1Password on this machine, then mint again"));
    if (/isn't a vault|is not a vault|not found|no vault/u.test(said)) return yield* Effect.fail(refused(`1Password has no vault named ${vault}`));
    if (/permission|not allowed|forbidden|owner|administrator/u.test(said)) return yield* Effect.fail(refused("This 1Password account may not create service accounts"));
    if (/rate|too many/u.test(said)) return yield* Effect.fail(refused("1Password is limiting requests; mint again later"));
    return yield* Effect.fail(refused("1Password refused to mint the vault token"));
  });

  /** On the window's machine: one token placed for one machine, the value known to the scrub for the call. */
  const place = Effect.fn("VaultSetup.place")(function* (input: MachineVaultTokenInput) {
    if (!VAULT_ENABLED) return yield* Effect.fail(off());
    const owner = `vault-token-delivery:${input.name}`;
    if (input.token !== undefined) registerKnownSecrets(owner, [input.token]);
    return yield* Effect.gen(function* () {
      const here = input.name === (yield* machines.machineName);
      const permissions = here ? WRITE : READ;
      const host = here ? undefined : yield* hosts.get(input.name);
      if (!here) {
        if (host === undefined || host.isThisMachine || (yield* machines.peer(input.name)) === undefined) return yield* Effect.fail(refused(`Set up ${input.name} from this machine before giving it a vault token`));
        if (host.juntoHome === undefined || host.installRoot === undefined) return yield* Effect.fail(refused(`Send Junto to ${input.name} before giving it a vault token`));
      }
      // Minted only once the machine is known to be ready for it, so no account is made for nothing.
      const account = input.mint === true ? `junto-${input.name}-${here ? "write" : "read"}` : undefined;
      const token = account === undefined ? input.token! : yield* mint(owner, account, input.vault, permissions);
      const origin: VaultTokenOrigin = account === undefined ? "pasted" : "minted";
      const unused = account === undefined ? "" : `; the service account ${account} was made in 1Password and is unused, so delete it there`;
      if (here) {
        yield* Effect.tryPromise({ try: () => writeVaultToken(options.home, token), catch: () => refused(`The vault token could not be written on this machine${unused}`) });
        return yield* recordHere({ vault: input.vault, permissions, origin, ...(account === undefined ? {} : { accountName: account }) });
      }
      const target = yield* parseHostSshRoute(host!);
      const stdin = yield* makeRemoteStdin(JSON.stringify({ vault: input.vault, permissions, token, ...(account === undefined ? {} : { accountName: account }) }));
      const program = yield* placeVaultToken(target, { juntoHome: host!.juntoHome!, installRoot: host!.installRoot! }, stdin);
      const output = yield* ssh.run(program).pipe(Effect.catch((cause) => Effect.fail(farRefusal(input.name, cause, unused))));
      const answer = Schema.decodeUnknownResult(Placed, { onExcessProperty: "error" })(output.stdout.trim().split("\n").at(-1));
      if (answer._tag === "Failure" || answer.success.data.machineName !== input.name) return yield* Effect.fail(refused(`${input.name} answered machine vault-token-local outside its contract`));
      const placed = answer.success.data;
      // This machine keeps the record of the token it handed out; the far machine holds its own.
      yield* tokens.put({ machineName: input.name, vault: placed.token.vault, permissions: placed.token.permissions, origin,
        ...(account === undefined ? {} : { accountName: account }), setAtEpochMs: placed.token.setAtEpochMs });
      return placed;
    }).pipe(Effect.ensuring(Effect.sync(() => releaseKnownSecrets(owner))));
  });

  /** On the machine the token is for: its own record, once `vault-token-local` placed the file. */
  const record = Effect.fn("VaultSetup.record")(function* (input: MachineVaultRecordInput) {
    if (!VAULT_ENABLED) return yield* Effect.fail(off());
    const held = yield* Effect.tryPromise({ try: () => readVaultToken(options.home), catch: () => refused("This machine's vault token could not be read") });
    if (held === undefined) return yield* Effect.fail(refused("No vault token is placed on this machine"));
    return yield* recordHere(input);
  });

  /** The machine list's view of each token this machine knows of. */
  const views = Effect.gen(function* () {
    if (!VAULT_ENABLED) return new Map<string, ReturnType<typeof vaultView>>();
    const at = now();
    return new Map((yield* tokens.list).map((row) => [row.machineName, vaultView(row, at)] as const));
  });

  return { place, record, views, forget: (name: string) => VAULT_ENABLED ? tokens.remove(name) : Effect.void };
});

export type VaultSetup = Effect.Success<ReturnType<typeof makeVaultSetup>>;

const Placed = Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(true), command: Schema.Literal("machine vault-token-local"), data: MachineVaultTokenData }));
const Refusal = Schema.fromJsonString(Schema.Struct({ ok: Schema.Literal(false), command: Schema.Literal("machine vault-token-local"), error: OperatorErrorBody }));

/** The far machine's own refusal when it said one; otherwise only that it could not be placed. */
const farRefusal = (name: string, cause: unknown, unused: string) => {
  if (cause instanceof SshExitError && cause.stderrTail !== undefined) {
    const said = Schema.decodeUnknownResult(Refusal, { onExcessProperty: "error" })(cause.stderrTail.trim().split("\n").at(-1));
    if (said._tag === "Success") return refused(`${name}: ${said.success.error.message}${unused}`);
  }
  return refused(`The vault token could not be placed on ${name}${unused}`);
};
