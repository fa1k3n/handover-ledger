/** A fault the user can act on. `howl` prints its message and no stack. */
export class LedgerError extends Error {}

export function isCode(e: unknown, code: string): boolean {
  return e instanceof Error && (e as NodeJS.ErrnoException).code === code;
}
