/**
 * Whether this machine runs code steps for a canvas (plan 0.11/05, Code
 * steps; docs/security-doctrine.md, Code steps, check 4). The allowance is
 * this machine's owner's choice, kept in `junto.db`
 * (`code-allowance-schema.ts`): never a fact, never synced, never set over a
 * link, the same as a secret (docs/machines.md Rule 9). It binds the canvas,
 * the ruling installations it trusts for that canvas (the editing machine,
 * and standby rulers when they come), and who may have authored the code.
 * The runner reads it before every run, so a withdrawal stops the next run;
 * one in flight ends at its timeout. No row allows nothing.
 */
import { Context, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CodeAllowanceScope, DEFAULT_CODE_ALLOWANCE_SCOPE } from "@shared/machine-code";
import { StateTransactionOperation } from "../state/service";

export { CodeAllowanceScope, DEFAULT_CODE_ALLOWANCE_SCOPE };

const InstallationName = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128)));

export const CodeAllowance = Schema.Struct({
  scope: CodeAllowanceScope,
  /** The installations whose rulings this machine runs code from, for this canvas. */
  installations: Schema.Array(InstallationName).pipe(Schema.check(Schema.isMinLength(1))),
});
export type CodeAllowance = typeof CodeAllowance.Type;

/** Who authored the code a step runs: the actor of the ruling that last set its code ref. */
export type CodeAuthor = "operator" | "overseer";

/** Why an allowance does not admit a run, or undefined when it does. */
export type CodeAllowanceRefusal = "canvas" | "installation" | "author";

export const allowanceRefusal = (
  allowance: CodeAllowance | undefined,
  rulingInstallation: string,
  author: CodeAuthor,
): CodeAllowanceRefusal | undefined => {
  if (allowance === undefined) return "canvas";
  if (!allowance.installations.includes(rulingInstallation)) return "installation";
  if (author === "overseer" && allowance.scope !== "operator-and-overseers") return "author";
  return undefined;
};

export class CodeAllowancePersistenceError extends Schema.TaggedError<CodeAllowancePersistenceError>()(
  "CodeAllowancePersistenceError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.Unknown,
  },
) {}

const persistence = (operation: string) => (cause: unknown) =>
  new CodeAllowancePersistenceError({ operation, message: `The code allowance could not be ${operation === "write" ? "written" : "read"}`, cause });

type AllowanceRow = { readonly canvas_name: string; readonly scope: string };
type InstallationRow = { readonly canvas_name: string; readonly installation_id: string };

const decodeScope = Schema.decodeUnknownSync(CodeAllowanceScope);

export class CodeAllowanceRepository extends Context.Service<
  CodeAllowanceRepository,
  {
    /** One canvas's allowance, or undefined when this machine runs no code for it. */
    readonly read: (canvasName: string) => Effect.Effect<CodeAllowance | undefined, CodeAllowancePersistenceError>;
    /** Every canvas this machine allows, by name. */
    readonly list: () => Effect.Effect<ReadonlyMap<string, CodeAllowance>, CodeAllowancePersistenceError>;
    /** Allow (replacing the installation list whole) or deny one canvas, in one transaction. */
    readonly write: (canvasName: string, allowance: CodeAllowance | undefined) => Effect.Effect<void, CodeAllowancePersistenceError>;
  }
>()("@junto/CodeAllowanceRepository") {}

export const CodeAllowanceRepositoryLive: Layer.Layer<CodeAllowanceRepository, never, SqlClient.SqlClient> = Layer.effect(
  CodeAllowanceRepository,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const fold = (rows: ReadonlyArray<AllowanceRow>, installations: ReadonlyArray<InstallationRow>): Map<string, CodeAllowance> => {
      const out = new Map<string, CodeAllowance>();
      for (const row of rows) {
        const listed = installations.filter(item => item.canvas_name === row.canvas_name).map(item => item.installation_id);
        // A row with no installation trusts no ruler, so it admits nothing: it is not an allowance.
        if (listed.length === 0) continue;
        out.set(row.canvas_name, { scope: decodeScope(row.scope), installations: listed });
      }
      return out;
    };

    const read = Effect.fn("codeAllowance.read")(function* (canvasName: string) {
      const rows = yield* sql<AllowanceRow>`
        SELECT canvas_name, scope FROM machine_code_allowances WHERE canvas_name = ${canvasName}`;
      const installations = yield* sql<InstallationRow>`
        SELECT canvas_name, installation_id FROM machine_code_allowance_installations
        WHERE canvas_name = ${canvasName} ORDER BY installation_id`;
      return fold(rows, installations).get(canvasName);
    }, Effect.mapError(persistence("read")));

    const list = Effect.fn("codeAllowance.list")(function* () {
      const rows = yield* sql<AllowanceRow>`
        SELECT canvas_name, scope FROM machine_code_allowances ORDER BY canvas_name`;
      const installations = yield* sql<InstallationRow>`
        SELECT canvas_name, installation_id FROM machine_code_allowance_installations
        ORDER BY canvas_name, installation_id`;
      return fold(rows, installations) as ReadonlyMap<string, CodeAllowance>;
    }, Effect.mapError(persistence("read")));

    const write = Effect.fn("codeAllowance.write")(function* (canvasName: string, allowance: CodeAllowance | undefined) {
      yield* sql`DELETE FROM machine_code_allowances WHERE canvas_name = ${canvasName}`;
      if (allowance === undefined) return;
      yield* sql`INSERT INTO machine_code_allowances (canvas_name, scope) VALUES (${canvasName}, ${allowance.scope})`;
      for (const installation of new Set(allowance.installations)) {
        yield* sql`
          INSERT INTO machine_code_allowance_installations (canvas_name, installation_id)
          VALUES (${canvasName}, ${installation})`;
      }
    }, sql.withTransaction, Effect.provideService(StateTransactionOperation, "codeAllowance.write"), Effect.mapError(persistence("write")));

    return CodeAllowanceRepository.of({ read, list, write });
  }),
);
