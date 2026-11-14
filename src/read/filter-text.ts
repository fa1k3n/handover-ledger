// What a filter text is, told without the CEL library and without Node, so the
// page can use it: the page sends pairs one by one and an expression whole.
// @code_class reading

/**
 * One `field=value` pair, as filters were before #82: a name, one `=`, and a
 * value that may hold spaces. Anything else is a CEL expression: no expression
 * starts with a name and a single `=`.
 */
export function isPair(text: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=(?!=)/.test(text);
}
