/**
 * A secret form's value, put where its region declares it (docs/machines.md,
 * The vault). The window sends only the signal and the value; the region, the
 * machine and the name come from the form the raise stored, never the caller,
 * so a value can only go where a declared source of that seat reads it.
 *
 * A `onepassword` source inside the region's vault is written with the window
 * machine's own write token, the value on `op`'s stdin only: an existing item
 * is read in memory, its one field set, and piped back to `op item edit`; a
 * missing one is made by `op item create --vault <V> -`. A `secret` source is
 * the local store's, so only for the window's own machine. The value is known
 * to the scrub from the moment it arrives, never in argv, an environment
 * value, a row or a log, and the answer carries names only.
 */
import { Effect, Schema } from "effect";
import { VAULT_ENABLED } from "@shared/features";
import { isThisMachine } from "@shared/machine-identity";
import type { Canvas, Region } from "@shared/model";
import type { EnvSource } from "@shared/model/region";
import { asNodeId } from "@shared/physics/schema";
import {
  isRefInVault,
  type SignalSecretPutReason,
  type SignalSecretPutResult,
  type VaultPermissions,
} from "@shared/vault";
import type { AgentSignal } from "@shared/agent-signals";
import { registerKnownSecrets, releaseKnownSecrets } from "../credentials/scrub";
import { MachineRepository } from "../machines/repository";
import { regionSecrets, type RegionSecrets } from "../region-env/secret-store";
import { opServiceAccountEnv } from "../region-env/sources";
import type { ToolResult, ToolRunner } from "../region-env/tool";
import { answerAgentSignal } from "../signals/operator";
import { AgentSignalRepository } from "../signals/repository";
import { WorkService } from "../work/service";
import { makeVaultTokens } from "./repository";
import { readVaultToken } from "./token-file";

/** The closed reasons and the answer shape are the window's contract: `@shared/vault`. */
export type SecretPutReason = SignalSecretPutReason;
export type SecretPutResult = SignalSecretPutResult;

/** Longer than any environment value a seat would read, under what one stdin write carries. */
export const SIGNAL_SECRET_VALUE_MAX = 16_384;
const OP_MS = 30_000;

export type SecretPutOptions = {
  /** The Junto home whose vault token this machine writes with. */
  readonly home: string;
  readonly userHome: string;
  readonly run: ToolRunner;
  readonly path: () => Promise<string | undefined>;
  readonly store?: Pick<RegionSecrets, "save">;
  readonly now?: () => number;
};

/** This machine's own token, with the scope its record holds; none when either is missing. */
const ownToken = (home: string, machineName: string) => Effect.gen(function* () {
  const record = yield* (yield* makeVaultTokens).get(machineName);
  const token = yield* Effect.promise(() => readVaultToken(home).catch(() => undefined));
  return record === undefined || token === undefined ? undefined : { token, permissions: record.permissions as VaultPermissions };
});

const refused = (reason: SecretPutReason, message: string): SecretPutResult => ({ ok: false, reason, message });

/** The source the region declares for this name and machine, a later one winning as the environment's plan says. */
type WritableSource = Extract<EnvSource, { readonly kind: "onepassword" | "secret" }>;

const declaredSource = (region: Region, name: string, machine: string): WritableSource | undefined =>
  (region.environment?.sources ?? []).filter((source): source is WritableSource =>
    (source.kind === "onepassword" || source.kind === "secret") && source.name === name &&
    (source.host === undefined || isThisMachine(source.host, machine))).at(-1);

/** `op://<vault>/<item>/<field>`, the one shape Junto writes; a section path is the operator's to write in 1Password. */
const refParts = (ref: string, vault: string): { readonly item: string; readonly field: string } | undefined => {
  if (!isRefInVault(ref, vault)) return undefined;
  const rest = ref.slice(`op://${vault}/`.length).split("/");
  return rest.length === 2 && rest.every((part) => part.length > 0) ? { item: rest[0]!, field: rest[1]! } : undefined;
};

const ListedItem = Schema.Struct({ id: Schema.String, title: Schema.String });
const OpField = Schema.Record(Schema.String, Schema.Unknown);

/** A refusal from `op` in fixed words; what it printed never leaves. */
const opRefusal = (result: Exclude<ToolResult, { readonly kind: "ok" }>): SecretPutResult => {
  if (result.kind === "not-installed") return refused("op-missing", "The 1Password CLI (op) is not installed on this machine");
  if (result.kind === "timeout") return refused("store-failed", "1Password did not answer in time; the value may not be set");
  const said = result.kind === "exit" ? result.stderr.toLowerCase() : "";
  if (/rate limit|too many requests|\b429\b/u.test(said)) return refused("rate-limited", "1Password is limiting requests; set it again later");
  if (/unauthori[sz]ed|invalid .*token|token .*(?:invalid|expired|revoked)|\b401\b|forbidden|\b403\b|not allowed|permission/u.test(said)) {
    return refused("token-refused", "1Password refused this machine's vault token for that write");
  }
  return refused("store-failed", "1Password did not take the value");
};

export const putSignalSecret = (input: { readonly signalId: string; readonly value: string }, ports: SecretPutOptions) =>
  Effect.gen(function* () {
    if (!VAULT_ENABLED) return refused("off", "The vault is not in this build");
    const owner = `signal-secret:${input.signalId}`;
    registerKnownSecrets(owner, [input.value]);
    return yield* Effect.gen(function* () {
      if (input.value.length === 0 || input.value.length > SIGNAL_SECRET_VALUE_MAX) {
        return refused("store-failed", `A secret holds 1 to ${SIGNAL_SECRET_VALUE_MAX} characters`);
      }
      const held = yield* (yield* AgentSignalRepository).get(input.signalId).pipe(Effect.option);
      const signal = held._tag === "Some" ? held.value : undefined;
      if (signal === undefined || signal.state !== "open") return refused("not-open", "This signal is not open");
      const form = signal.form;
      if (form?.kind !== "secret") return refused("not-declared", "This signal asks for no secret");
      const read = yield* (yield* WorkService).readTopology(signal.canvasName).pipe(Effect.option);
      const canvas: Canvas | undefined = read._tag === "Some" ? read.value.canvas : undefined;
      const region = canvas?.nodes.get(asNodeId(form.regionId));
      const source = region?.kind === "region" ? declaredSource(region, form.name, form.machine) : undefined;
      if (region?.kind !== "region" || source === undefined) {
        return refused("not-declared", `The region no longer declares ${form.name} for ${form.machine}`);
      }
      const here = yield* (yield* MachineRepository).machineName;

      let item: string;
      if (source.kind === "secret") {
        // The local store is this machine's; a seat elsewhere reads its own.
        if (!isThisMachine(form.machine, here)) {
          return refused("other-machine-store", `${form.name} is in ${form.machine}'s own secret store; set it there, or declare it in the region's vault`);
        }
        const saved = (ports.store ?? regionSecrets()).save({ value: input.value, secretId: source.secretId });
        if (!saved.ok) return refused("store-failed", saved.message);
        item = saved.secretId;
      } else {
        const vault = region.environment?.vault?.vault;
        const parts = vault === undefined || source.tokenFrom !== undefined ? undefined : refParts(source.ref, vault);
        if (vault === undefined || parts === undefined) {
          return refused("not-in-vault", `${form.name} is not read from the region's vault as op://<vault>/<item>/<field>, so Junto does not write it`);
        }
        const own = yield* ownToken(ports.home, here);
        if (own === undefined || own.permissions !== "read_items,write_items") {
          return refused("no-vault-token", "This machine holds no vault token that writes; give it one with junto machine vault-token");
        }
        const env = opServiceAccountEnv(own.token, yield* Effect.promise(() => ports.path()), ports.userHome);
        const op = (args: ReadonlyArray<string>, purpose: string, stdin?: string) =>
          Effect.promise(() => ports.run({ command: "op", args, timeoutMs: OP_MS, env, purpose, ...(stdin === undefined ? {} : { stdin }) }));

        // Titles and ids only: listing reads no value.
        const listed = yield* op(["item", "list", "--vault", vault, "--format", "json"], "find a vault item");
        if (listed.kind !== "ok") return opRefusal(listed);
        const items = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(ListedItem)))(listed.stdout);
        if (items._tag === "None") return refused("store-failed", "1Password answered the item list outside its shape");
        const matches = items.value.filter((entry) => entry.id === parts.item || entry.title === parts.item);
        if (matches.length > 1) return refused("store-failed", `The vault holds more than one item named ${parts.item}; rename one in 1Password`);

        const existing = matches[0];
        if (existing === undefined) {
          const template = JSON.stringify({
            title: parts.item, category: "PASSWORD",
            fields: [{ id: parts.field, label: parts.field, type: "CONCEALED", ...(parts.field === "password" ? { purpose: "PASSWORD" } : {}), value: input.value }],
          });
          const created = yield* op(["item", "create", "--vault", vault, "-"], "create a vault item", template);
          if (created.kind !== "ok") return opRefusal(created);
          item = parts.item;
        } else {
          // The item's own values are read here in memory to keep them, and known to the scrub until the edit is done.
          const got = yield* op(["item", "get", existing.id, "--vault", vault, "--format", "json"], "read a vault item to set one field");
          if (got.kind !== "ok") return opRefusal(got);
          let body: Record<string, unknown>;
          try { body = JSON.parse(got.stdout) as Record<string, unknown>; } catch { return refused("store-failed", "1Password answered the item outside its shape"); }
          const fields = Array.isArray(body.fields) ? body.fields.filter((field) => Schema.is(OpField)(field)) as Array<Record<string, unknown>> : [];
          registerKnownSecrets(owner, [input.value, ...fields.flatMap((field) => typeof field.value === "string" ? [field.value] : [])]);
          const at = fields.findIndex((field) => field.id === parts.field || field.label === parts.field);
          const set = at === -1
            ? [...fields, { id: parts.field, label: parts.field, type: "CONCEALED", value: input.value }]
            : fields.map((field, index) => index === at ? { ...field, value: input.value } : field);
          const edited = yield* op(["item", "edit", existing.id, "--vault", vault], "set one field of a vault item", JSON.stringify({ ...body, fields: set }));
          if (edited.kind !== "ok") return opRefusal(edited);
          item = existing.title;
        }
      }

      // Set first, then answered: an answer that cannot be recorded leaves the value set and the signal open to set again.
      const answered = yield* answerAgentSignal(input.signalId, `${form.name} is set.`, {
        reply: { kind: "secret", item, name: form.name, regionId: form.regionId, machine: form.machine, setAt: (ports.now ?? Date.now)() },
      });
      const done: SecretPutResult = answered.ok
        ? { ok: true, item, signal: answered.signal, ...(answered.messageId === undefined ? {} : { messageId: answered.messageId }) }
        : { ok: true, item };
      return done;
    }).pipe(Effect.ensuring(Effect.sync(() => releaseKnownSecrets(owner))));
  });
