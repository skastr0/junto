import { Context } from "effect";

/**
 * Attribution retained across an owning SQL transaction and its receipts.
 *
 * On its own, apart from state/service.ts, so a repository that only names a
 * transaction can import it without linking the StateEngine tag and the engine
 * shape into its process: main's browser stores do exactly that.
 */
export const StateTransactionOperation = Context.Reference<string>(
  "@junto/StateTransactionOperation",
  { defaultValue: () => "sql.transaction" },
);
