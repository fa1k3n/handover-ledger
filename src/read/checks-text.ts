// What the data of an event of the checks says, as text (#47): the names of the checks that failed in a result, or of
// the ones still going when a head was let go. Names only; a control character in a name is taken out.
// No Node, so the page can use it.
// @code_class reading
import type { LedgerEvent } from "../ledger/schema.ts";

/** The names an event of the checks holds, joined: `lint, unit`; nothing where it holds none. */
export function checksNames(event: Pick<LedgerEvent, "type" | "data">): string {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const names = event.type === "checks.failed" ? d.failed : event.type === "checks.unfinished" ? d.unfinished : undefined;
  if (!Array.isArray(names)) return "";
  return names.map((n) => String(n).replace(/[\p{C}\p{Zl}\p{Zp}]/gu, "")).join(", ");
}
