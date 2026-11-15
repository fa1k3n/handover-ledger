// The trace of requirements to tests, read from the repository alone (#88):
// the requirements a team keeps as Markdown tables, the tests that name them,
// and the gaps between the two. Nothing is written, and nothing here knows
// the ledger.
//
// The settings are top-level keys of .howl/howl.yml, read here and not by
// `findProject`, so that the hook stays as quick as it is.
// @code_class recording
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LedgerError } from "../ledger/errors.ts";
import { matchesGlob } from "./classes.ts";
import { commitOf, filesAt, textAt, trackedFiles } from "./git.ts";
import { topLevel } from "./project.ts";

const SETTINGS = ".howl/howl.yml";

export interface TraceSettings {
  /** Globs of the files that hold the tables. */
  requirementsIn: string[];
  /** What an ID looks like, as a regular expression. */
  pattern: RegExp;
  /** The headings of the ID, the method and the status. */
  columns: { id: string; method?: string; status?: string };
  /** The methods that ask for a test. */
  byTest: string[];
  /** The statuses that say a requirement is built. */
  done: string[];
  /** Globs of the files that hold tests. */
  testsIn: string[];
  /** Each finds a test; its first group is the test's name. */
  testPatterns: RegExp[];
}

/** Where the files are read from: the working tree, or one commit. */
export interface Source {
  /** The commit, or null for the working tree. */
  at: string | null;
  /** The files, named from the folder that holds `.howl/`. */
  files(): string[];
  /** The text of one of them, or null when it cannot be read. */
  read(file: string): string | null;
}

/** A test, by where its name stands. */
export interface TestRef {
  file: string;
  line: number;
  name: string;
}

export interface Requirement {
  /** As the table writes it. */
  id: string;
  method?: string;
  status?: string;
  file: string;
  line: number;
  /** The SHA-256 of the row: its cells trimmed and joined by a tab, the status left out. */
  version: string;
  /** Whether its method asks for a test. */
  by_test: boolean;
  /** Whether its status says it is built. */
  built: boolean;
  covered_by: TestRef[];
  touched_by: TestRef[];
}

export interface Test extends TestRef {
  /** The IDs it covers and touches, in their fixed form: upper case, with `-`. */
  covers: string[];
  touches: string[];
}

export type Gap =
  | { kind: "no_test"; id: string; file: string; line: number }
  | { kind: "unknown_id"; id: string; file: string; line: number; test: string }
  | { kind: "twice"; id: string; file: string; line: number; first: { file: string; line: number } };

export interface TraceReport {
  at: string | null;
  requirements: Requirement[];
  tests: Test[];
  gaps: Gap[];
  counts: { requirements: number; tests: number; tests_naming_none: number; gaps: number };
}

/** The folder of the nearest `.howl/howl.yml` at or above `dir`, or null. */
export function traceRoot(dir: string): string | null {
  for (let at = dir; ; at = dirname(at)) {
    if (existsSync(join(at, SETTINGS))) return at;
    if (dirname(at) === at) return null;
  }
}

/** The files git tracks below `root`, as they stand in the working tree. */
export function workingTree(root: string): Source {
  return {
    at: null,
    files() {
      const names = trackedFiles(root);
      if (names === null) throw new LedgerError("git did not list the files: is this a git repository?");
      return names.filter((name) => existsSync(join(root, name)));
    },
    read(file) {
      try {
        return readFileSync(join(root, file), "utf8");
      } catch {
        return null;
      }
    },
  };
}

/** The files of one commit below `root`. Nothing of the working tree is read. */
export function treeAt(root: string, name: string): Source {
  const commit = commitOf(root, name);
  if (commit === null) throw new LedgerError(`no commit ${name}: is this a git repository, and does it have that commit?`);
  return {
    at: commit,
    files() {
      const names = filesAt(root, commit);
      if (names === null) throw new LedgerError(`git did not list the files of ${commit}`);
      return names;
    },
    read: (file) => textAt(root, commit, file),
  };
}

/**
 * The trace settings of the nearest `.howl/howl.yml` at or above `dir`, read
 * from `source` (the working tree when none is given). Null when there is no
 * such file or it has no `requirements_in`.
 */
export function findTrace(dir: string, source?: Source): TraceSettings | null {
  const root = traceRoot(dir);
  if (root === null) return null;
  const text = (source ?? workingTree(root)).read(SETTINGS);
  return text === null ? null : readSettings(text);
}

function readSettings(text: string): TraceSettings | null {
  const settings = topLevel(text);
  const list = (key: string): string[] => {
    const v = settings.get(key);
    return v === undefined ? [] : typeof v === "string" ? [v] : v;
  };
  const requirementsIn = list("requirements_in");
  if (requirementsIn.length === 0) return null;

  const need = (key: string, why: string): string[] => {
    const v = list(key);
    if (v.length === 0) throw new LedgerError(`${key} is needed in ${SETTINGS}: ${why}`);
    return v;
  };
  const expression = (key: string, source: string, flags: string): RegExp => {
    try {
      return new RegExp(source, flags);
    } catch {
      throw new LedgerError(`${key} is not a regular expression: ${source}`);
    }
  };
  const pattern = expression("requirement_pattern", need("requirement_pattern", "what an ID looks like")[0]!, "i");
  const [id = "ID", method, status] = list("requirement_columns");
  const columns: TraceSettings["columns"] = { id };
  if (method !== undefined) columns.method = method;
  if (status !== undefined) columns.status = status;
  return {
    requirementsIn,
    pattern,
    columns,
    byTest: method === undefined ? [] : need("requirement_by_test", `the values of ${method} that ask for a test`),
    done: status === undefined ? [] : need("requirement_done", `the values of ${status} that say a requirement is built`),
    testsIn: need("tests_in", "the files that hold tests"),
    // Over the whole text of a file: a name may stand on the line after its mark.
    testPatterns: need("test_pattern", "how a test's name is found").map((p) => expression("test_pattern", p, "gmd")),
  };
}

/** An ID in its fixed form: upper case, with `_` read as `-`. */
export function fixedId(id: string): string {
  return id.toUpperCase().replace(/_/g, "-");
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The cells of a table's line, trimmed, with an escaped `|` put back; null when the line is no table line. */
function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|")) return null;
  const parts = t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  return parts.slice(1, parts.at(-1) === "" ? -1 : undefined);
}

const isDashes = (row: string[]) => row.length > 0 && row.every((c) => /^:?-+:?$/.test(c));

interface Row {
  id: string;
  method?: string;
  status?: string;
  line: number;
  version: string;
}

/**
 * The requirements of a Markdown text: the rows of every table whose heading
 * row holds the ID's heading, whose ID cell is an ID. A table inside a block
 * of code is an example and is passed over.
 */
export function rowsOf(text: string, settings: TraceSettings): Row[] {
  const whole = new RegExp(`^(?:${settings.pattern.source})$`, "i");
  const rows: Row[] = [];
  const lines = text.split(/\r?\n/);
  let fence: string | null = null;
  // The places of the columns in the table being read, or null outside one.
  let at: { id: number; method: number; status: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const mark = /^\s*(`{3,}|~{3,})/.exec(lines[i]!)?.[1];
    if (mark !== undefined) {
      if (fence === null) fence = mark[0]!;
      else if (mark[0] === fence) fence = null;
      at = null;
      continue;
    }
    const row = fence === null ? cells(lines[i]!) : null;
    if (row === null) {
      at = null;
      continue;
    }
    if (at === null) {
      // A heading row is one with a row of dashes below it.
      const below = cells(lines[i + 1] ?? "");
      if (below === null || !isDashes(below)) continue;
      const place = (name: string | undefined) => (name === undefined ? -1 : row.findIndex((c) => same(c, name)));
      const id = place(settings.columns.id);
      i++;
      // A table with no ID heading is read to its end, and gives nothing.
      at = { id, method: place(settings.columns.method), status: place(settings.columns.status) };
      continue;
    }
    if (at.id < 0) continue;
    const id = row[at.id] ?? "";
    if (!whole.test(id)) continue;
    const found: Row = {
      id,
      line: i + 1,
      version: createHash("sha256")
        .update(row.filter((_, n) => n !== at!.status).join("\t"), "utf8")
        .digest("hex"),
    };
    if (at.method >= 0) found.method = row[at.method] ?? "";
    if (at.status >= 0) found.status = row[at.status] ?? "";
    rows.push(found);
  }
  return rows;
}

/** The IDs in a text, in their fixed form, each once, in the order they stand. */
function idsIn(text: string, pattern: RegExp): string[] {
  const found = fixedId(text).match(new RegExp(pattern.source, "gi")) ?? [];
  return [...new Set(found.map(fixedId))];
}

/**
 * The tests of a file: each match of a test pattern, with the IDs its name
 * covers (the one it starts with) and touches (those in round brackets), and
 * those of the `covers:` and `touches:` comments between it and the test above.
 */
export function testsOf(text: string, file: string, settings: TraceSettings): Test[] {
  const lineAt = (index: number) => {
    let line = 1;
    for (let i = text.indexOf("\n"); i >= 0 && i < index; i = text.indexOf("\n", i + 1)) line++;
    return line;
  };
  const byLine = new Map<number, Test>();
  const starts = new RegExp(`^(?:${settings.pattern.source})(?![A-Za-z0-9])`, "i");
  for (const pattern of settings.testPatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1] ?? match[0];
      const line = lineAt(match.indices?.[1]?.[0] ?? match.index);
      if (byLine.has(line)) continue;
      const fixed = fixedId(name);
      const first = starts.exec(fixed)?.[0];
      const inBrackets = [...fixed.matchAll(/\(([^)]*)\)/g)].flatMap((m) => idsIn(m[1]!, settings.pattern));
      const covers = first === undefined ? [] : [fixedId(first)];
      byLine.set(line, { file, line, name, covers, touches: [...new Set(inBrackets)].filter((id) => !covers.includes(id)) });
    }
  }
  const tests = [...byLine.values()].sort((a, b) => a.line - b.line);

  // A comment counts for the next test below it.
  const lines = text.split(/\r?\n/);
  let next = 0;
  for (let i = 0; i < lines.length; i++) {
    while (next < tests.length && tests[next]!.line <= i + 1) next++;
    const said = /\b(covers|touches):\s*(.*)$/i.exec(lines[i]!);
    const test = tests[next];
    if (said === null || test === undefined) continue;
    const ids = idsIn(said[2]!, settings.pattern);
    if (said[1]!.toLowerCase() === "covers") {
      test.covers = [...new Set([...test.covers, ...ids])];
      test.touches = test.touches.filter((id) => !test.covers.includes(id));
    } else {
      test.touches = [...new Set([...test.touches, ...ids])].filter((id) => !test.covers.includes(id));
    }
  }
  return tests;
}

/** The requirements, the tests and the gaps of a source. Only reads. */
export function trace(settings: TraceSettings, source: Source): TraceReport {
  const files = source.files().sort();
  const inAny = (globs: string[]) => files.filter((file) => globs.some((glob) => matchesGlob(glob, file)));
  const gaps: Gap[] = [];

  const requirements: Requirement[] = [];
  const byId = new Map<string, Requirement>();
  for (const file of inAny(settings.requirementsIn)) {
    for (const row of rowsOf(source.read(file) ?? "", settings)) {
      const first = byId.get(fixedId(row.id));
      if (first !== undefined) {
        gaps.push({ kind: "twice", id: row.id, file, line: row.line, first: { file: first.file, line: first.line } });
        continue;
      }
      const requirement: Requirement = {
        id: row.id,
        ...(row.method === undefined ? {} : { method: row.method }),
        ...(row.status === undefined ? {} : { status: row.status }),
        file,
        line: row.line,
        version: row.version,
        by_test: row.method === undefined || settings.byTest.some((m) => same(m, row.method!)),
        built: row.status === undefined || settings.done.some((s) => same(s, row.status!)),
        covered_by: [],
        touched_by: [],
      };
      requirements.push(requirement);
      byId.set(fixedId(row.id), requirement);
    }
  }

  const tests: Test[] = [];
  const unknown: Gap[] = [];
  for (const file of inAny(settings.testsIn)) {
    for (const test of testsOf(source.read(file) ?? "", file, settings)) {
      tests.push(test);
      const ref: TestRef = { file: test.file, line: test.line, name: test.name };
      for (const [ids, link] of [
        [test.covers, "covered_by"],
        [test.touches, "touched_by"],
      ] as const) {
        for (const id of ids) {
          const requirement = byId.get(id);
          if (requirement !== undefined) requirement[link].push(ref);
          else unknown.push({ kind: "unknown_id", id, file: test.file, line: test.line, test: test.name });
        }
      }
    }
  }

  const untested: Gap[] = requirements
    .filter((r) => r.by_test && r.built && r.covered_by.length === 0)
    .map((r) => ({ kind: "no_test", id: r.id, file: r.file, line: r.line }));
  const all = [...untested, ...unknown, ...gaps];
  return {
    at: source.at,
    requirements,
    tests,
    gaps: all,
    counts: {
      requirements: requirements.length,
      tests: tests.length,
      tests_naming_none: tests.filter((t) => t.covers.length === 0 && t.touches.length === 0).length,
      gaps: all.length,
    },
  };
}

/** A gap in one line, starting with its place. */
export function gapLine(gap: Gap, report: TraceReport): string {
  const at = `${gap.file}:${gap.line}`;
  switch (gap.kind) {
    case "no_test": {
      const touched = report.requirements.find((r) => r.id === gap.id)?.touched_by.length ?? 0;
      return `${at} ${gap.id}: built and by test, and no test covers it${touched === 0 ? "" : ` (${touched} touch${touched === 1 ? "es" : ""} it)`}`;
    }
    case "unknown_id":
      return `${at} ${gap.test}: names ${gap.id}, which no table holds`;
    case "twice":
      return `${at} ${gap.id}: given twice, first at ${gap.first.file}:${gap.first.line}`;
  }
}

/** The counts in one line: `7 requirements, 9 tests (2 name no requirement)`. */
export function countsLine(report: TraceReport): string {
  const { requirements, tests, tests_naming_none: none } = report.counts;
  const s = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  return `${s(requirements, "requirement")}, ${s(tests, "test")}${none === 0 ? "" : ` (${none} name${none === 1 ? "s" : ""} no requirement)`}`;
}
