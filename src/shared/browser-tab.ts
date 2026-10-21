import { Schema } from "effect";
import { BROWSER_MAX_SESSION_ID_BYTES, isUtf8WithinLimit } from "./browser-limits";

/**
 * One tab of a page node. A page holds an ordered list of tabs; a browser
 * command that names none acts on the active tab (plan 06).
 *
 * The CLI names a tab with `--tab`. The ids themselves come from the page's
 * tab list, which product-attention's tabs work owns; until it lands this is
 * the shape the CLI sends, and the control server refuses `tab` as an unknown
 * field rather than acting on the wrong tab.
 */
const TAB_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export const isValidBrowserTabId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  isUtf8WithinLimit(value, BROWSER_MAX_SESSION_ID_BYTES) &&
  TAB_ID.test(value);

export const BrowserTabId = Schema.String.pipe(
  Schema.check(Schema.makeFilter(isValidBrowserTabId,
  { message: "tab must be nonempty bounded ASCII" },)),
  Schema.brand("BrowserTabId"),
);
export type BrowserTabId = typeof BrowserTabId.Type;
