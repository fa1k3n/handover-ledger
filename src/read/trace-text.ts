// What a head's tests name, in one line (#38). Apart from `show.ts` so that the
// page can use it; no imports.
// @code_class reading

/** What was read of a head's tests: the IDs they cover and touch, and how many tests name one. */
export interface HeadTrace {
  covered: string[];
  touched: string[];
  tests: number;
}

/** #38: what a head's tests name, in one line: the IDs covered, a gap said plainly, or that nothing was read. */
export function traceText(trace: HeadTrace | undefined): string {
  if (trace === undefined) return "requirements: not recorded";
  const tests = (n: number) => `${n} test${n === 1 ? "" : "s"}`;
  if (trace.covered.length > 0) {
    return `requirements: ${trace.covered.join(", ")} covered by ${tests(trace.tests)}${trace.touched.length > 0 ? `; touched: ${trace.touched.join(", ")}` : ""}`;
  }
  return trace.touched.length > 0 ? `requirements: none covered; touched: ${trace.touched.join(", ")}` : "no test names a requirement";
}
