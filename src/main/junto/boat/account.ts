/**
 * Boat keys, minted and revoked through the operator's signed-in `boat` CLI
 * on the editing machine (docs/machines.md, Boat machines; security doctrine,
 * Boat machines). The CLI is a secret tool here: its stdout is parsed in
 * memory and only the key goes on; its stdout and stderr never become a tail,
 * a log or a failure, because it prints the key and sign-in links. argv is
 * fixed and carries no key.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { Schema } from "effect";
import { BOAT_ACCOUNT_KEY_ACTIONS, BOAT_MACHINE_KEY_ACTIONS, BoatKeyId, type BoatSandboxId } from "@shared/boat";
import { forcedSecretStoreOf, openPlatformSecretStore, SECRET_STORE_ENV, type CredentialStore } from "../credentials/store";
import { BoatKeySecret, boatDir } from "./files";

export const BoatKeyCheck = Schema.Literals(["cli-missing", "not-signed-in", "refused", "unreadable", "store-refused", "timeout", "not-connected"]);
export type BoatKeyCheck = typeof BoatKeyCheck.Type;

const SENTENCES: Record<BoatKeyCheck, string> = {
  "cli-missing": "The Boat CLI is not installed on this machine. Install it and sign in with `boat login`",
  "not-signed-in": "The Boat CLI is not signed in. Run `boat login`, then try again",
  refused: "Boat refused to make or revoke the key",
  unreadable: "The Boat CLI's answer could not be read",
  "store-refused": "This machine's secret store did not take the Boat key",
  timeout: "The Boat CLI did not answer in time",
  "not-connected": "Connect the Boat account first: `junto machine boat-connect '{}'`",
};

export class BoatKeyFailed extends Schema.TaggedError<BoatKeyFailed>()("BoatKeyFailed", {
  check: BoatKeyCheck,
  message: Schema.String,
}) {}
export const boatKeyFailed = (check: BoatKeyCheck): BoatKeyFailed => new BoatKeyFailed({ check, message: SENTENCES[check] });

const CLI_TIMEOUT_MS = 90_000;

/** The CLI on PATH, or where Boat's installer puts it. */
const findBoatCli = async (): Promise<string> => {
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, "boat")),
    join(homedir(), ".ascii", "bin", "boat"),
  ];
  for (const path of candidates) {
    try { await access(path, constants.X_OK); return path; } catch { /* next */ }
  }
  throw boatKeyFailed("cli-missing");
};

/** Runs the CLI with fixed argv; answers its parsed JSON and nothing it printed. */
const runBoatCli = async (args: ReadonlyArray<string>): Promise<unknown> => {
  const cli = await findBoatCli();
  const out = await new Promise<{ readonly code: number; readonly stdout: string }>((resolve, reject) => {
    execFile(cli, [...args, "--json", "--no-update"], {
      timeout: CLI_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true,
      env: { ...process.env, BOAT_NO_UPDATE: "true" },
    }, (error, stdout) => {
      if (error !== null && (error as { killed?: boolean }).killed) return reject(boatKeyFailed("timeout"));
      if (error !== null && (error as { code?: unknown }).code === "ENOENT") return reject(boatKeyFailed("cli-missing"));
      resolve({ code: error === null ? 0 : typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : 1, stdout: String(stdout) });
    });
  });
  const parsed = parseLastJson(out.stdout);
  if (out.code !== 0) {
    const status = typeof parsed === "object" && parsed !== null ? (parsed as { status?: unknown; code?: unknown }) : {};
    throw boatKeyFailed(status.status === 401 || status.code === "unauthorized" ? "not-signed-in" : "refused");
  }
  if (parsed === undefined) throw boatKeyFailed("unreadable");
  return parsed;
};

/** The whole output as one document, or else its last JSON line. */
const parseLastJson = (stdout: string): unknown => {
  try { return JSON.parse(stdout); } catch { /* lines */ }
  for (const line of stdout.trim().split("\n").reverse()) {
    try { return JSON.parse(line); } catch { /* earlier */ }
  }
  return undefined;
};

const Minted = Schema.Struct({
  apiKey: Schema.Struct({
    id: BoatKeyId,
    expiresAt: Schema.optionalKey(Schema.NullOr(Schema.String.pipe(Schema.check(Schema.isMaxLength(64))))),
    scope: Schema.Struct({
      actions: Schema.Array(Schema.String),
      sandboxes: Schema.Union([Schema.Literal("*"), Schema.Array(Schema.String)]),
    }),
  }),
  secret: BoatKeySecret,
});

export interface MintedBoatKey {
  readonly id: typeof BoatKeyId.Type;
  readonly secret: string;
  readonly expiresAt?: string;
}

const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
  a.length === b.length && [...a].sort().every((value, index) => value === [...b].sort()[index]);

/**
 * Mints a key and reads its scope back: a key whose actions or sandboxes are
 * not exactly the ones asked for is revoked at once and refused.
 */
const mint = async (name: string, actions: ReadonlyArray<string>, sandbox?: BoatSandboxId): Promise<MintedBoatKey> => {
  const raw = await runBoatCli([
    "api-key", "create", name, "--ttl", "365d", "--actions", actions.join(","),
    ...(sandbox === undefined ? [] : ["--sandbox", sandbox]),
  ]);
  let minted: typeof Minted.Type;
  try { minted = Schema.decodeUnknownSync(Minted)(raw); } catch {
    // Boat made a key we cannot read: revoked by its id when that much is readable, never left behind.
    const id = (raw as { apiKey?: { id?: unknown } } | undefined)?.apiKey?.id;
    if (Schema.is(BoatKeyId)(id)) await revokeBoatKey(id).catch(() => undefined);
    throw boatKeyFailed("unreadable");
  }
  const { scope } = minted.apiKey;
  const sandboxesRight = sandbox === undefined ? scope.sandboxes === "*" : Array.isArray(scope.sandboxes) && sameSet(scope.sandboxes, [sandbox]);
  if (!sameSet(scope.actions, actions) || !sandboxesRight) {
    await revokeBoatKey(minted.apiKey.id).catch(() => undefined);
    throw boatKeyFailed("refused");
  }
  return { id: minted.apiKey.id, secret: minted.secret, ...(minted.apiKey.expiresAt ? { expiresAt: minted.apiKey.expiresAt } : {}) };
};

export const mintBoatAccountKey = (machineName: string): Promise<MintedBoatKey> =>
  mint(`junto ${machineName}`, BOAT_ACCOUNT_KEY_ACTIONS);

export const mintBoatMachineKey = (machineName: string, sandboxId: BoatSandboxId): Promise<MintedBoatKey> =>
  mint(`junto machine ${machineName}`, BOAT_MACHINE_KEY_ACTIONS, sandboxId);

export const revokeBoatKey = async (id: typeof BoatKeyId.Type): Promise<void> => {
  const raw = await runBoatCli(["api-key", "revoke", Schema.decodeUnknownSync(BoatKeyId)(id)]);
  if (typeof raw !== "object" || raw === null || (raw as { ok?: unknown }).ok !== true) throw boatKeyFailed("refused");
};

// --- The account key in this machine's secret store ---------------------------

/** The account key's fixed id in the store. */
export const BOAT_ACCOUNT_SECRET_ID = "7b0a7c3e-5d1f-4a2b-9c8e-0b1a2c3d4e5f";

let opened: { readonly home: string; readonly store: CredentialStore } | undefined;
const accountStore = (home: string): CredentialStore => {
  if (opened?.home !== home) {
    opened = { home, store: openPlatformSecretStore({ directory: join(boatDir(home), "secrets"), forced: forcedSecretStoreOf(process.env[SECRET_STORE_ENV]) }).store };
  }
  return opened.store;
};

export const storeBoatAccountKey = (home: string, secret: string): void => {
  const store = accountStore(home);
  try { store.put(BOAT_ACCOUNT_SECRET_ID, Schema.decodeUnknownSync(BoatKeySecret)(secret)); } catch { throw boatKeyFailed("store-refused"); }
};

export const readBoatAccountKey = (home: string): string | undefined => {
  try {
    const value = accountStore(home).get(BOAT_ACCOUNT_SECRET_ID);
    return value !== undefined && Schema.is(BoatKeySecret)(value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export const deleteBoatAccountKey = (home: string): void => {
  try { accountStore(home).delete(BOAT_ACCOUNT_SECRET_ID); } catch { throw boatKeyFailed("store-refused"); }
};

/** Whether the operator's CLI is installed and signed in: asked before anything is made. */
export const requireBoatCliSignedIn = async (): Promise<void> => {
  const raw = await runBoatCli(["status"]);
  const state = typeof raw === "object" && raw !== null ? (raw as { account?: { loginState?: unknown } }).account?.loginState : undefined;
  if (state !== "active") throw boatKeyFailed("not-signed-in");
};
