// The project of a working directory, from the nearest .howl/howl.yml above it,
// and the agent a session runs for.
//
// howl.yml is read with a small reader of its own, not a YAML library: only
// top-level keys are read, with a plain value or a list of plain values
// (`[a, b]`, or `- a` lines under the key). Everything else indented is passed
// over. That is all this step needs, and it keeps the hook quick and free of
// dependencies. A `#` after white space starts a comment, also inside quotes.
// @code_class recording
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProjectName } from "../ledger/place.ts";

export interface Project {
  /** The folder that holds `.howl/`. */
  root: string;
  project: string;
  /** How many days activity is kept. */
  activityDays: number;
  /** The code host: `github`, or `local` for a folder of JSON files. */
  host?: string;
  /** The repository at the code host, as `owner/name`. */
  repository?: string;
  /** A regular expression that takes a task's number from a branch name: its first group, else the whole match. */
  taskFromBranch?: string;
  /** #28: a regular expression a comment's first line must match to count as a review. */
  reviewCommentPattern?: string;
  /** For the local host: its folder, relative to the root. */
  local?: string;
  /** The agents, as written: `name` (the name and the account are the same) or `name=account` (#46). */
  agents: string[];
}

export const DEFAULT_ACTIVITY_DAYS = 30;

/** The nearest `.howl/howl.yml` at or above `dir`, or null when there is none or it names no project. */
export function findProject(dir: string): Project | null {
  for (let at = dir; ; at = dirname(at)) {
    let text: string | null = null;
    try {
      text = readFileSync(join(at, ".howl", "howl.yml"), "utf8");
    } catch {
      // Not here; look further up.
    }
    if (text !== null) return read(at, text);
    if (dirname(at) === at) return null;
  }
}

function read(root: string, text: string): Project | null {
  const settings = topLevel(text);
  const value = (key: string) => {
    const v = settings.get(key);
    return typeof v === "string" ? v : undefined;
  };
  const project = value("project");
  if (project === undefined || !isProjectName(project)) return null;
  let activityDays = DEFAULT_ACTIVITY_DAYS;
  const days = settings.get("activity_days");
  if (days !== undefined) {
    if (typeof days !== "string" || !/^[1-9][0-9]*$/.test(days)) return null;
    activityDays = Number(days);
  }
  const agents = settings.get("agents");
  const found: Project = {
    root,
    project,
    activityDays,
    agents: agents === undefined ? [] : typeof agents === "string" ? [agents] : agents,
  };
  for (const [key, field] of [
    ["host", "host"],
    ["repository", "repository"],
    ["task_from_branch", "taskFromBranch"],
    ["review_comment_pattern", "reviewCommentPattern"],
    ["local", "local"],
  ] as const) {
    const v = value(key);
    if (v !== undefined) found[field] = v;
  }
  return found;
}

/** #46: an entry of `agents` as a name and an account; none when a side is empty or there is more than one `=`. */
function agentEntry(entry: string): { name: string; account: string } | null {
  const parts = entry.split("=").map((p) => p.trim());
  if (parts.length === 1) return parts[0] === "" ? null : { name: parts[0]!, account: parts[0]! };
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") return null;
  return { name: parts[0]!, account: parts[1]! };
}

/**
 * #46: what keeps a list of `agents` from being read as meant, one sentence for each: an entry with an empty side or
 * more than one `=`, and an account that two entries give (a plain entry gives its name). Accounts are compared
 * without regard to case, as a code host compares them. One name with two accounts is allowed. The list is refused
 * as a whole when this gives anything.
 */
export function agentFaults(entries: string[]): string[] {
  const faults: string[] = [];
  const taken = new Map<string, string>();
  const parsed = entries.map((entry) => ({ entry, e: agentEntry(entry) }));
  for (const { entry, e } of parsed) {
    if (e === null) {
      faults.push(`agents: the entry "${entry}" is not name or name=account (a side is empty, or there is more than one =)`);
      continue;
    }
    // The reader hands over a broken list as odd entries (a missing comma joins two, a missing bracket or quote stays
    // in the text), so the plain characters are checked here: such an entry is never read as a name.
    if (!/^[A-Za-z0-9._-]+$/.test(e.name) || !/^[A-Za-z0-9._-]+(\[bot\])?$/.test(e.account)) {
      faults.push(`agents: the entry "${entry}" holds more than letters, digits, - _ . in a name or an account (and [bot] at the end of an account): a comma, a bracket or a quote may be missing`);
      continue;
    }
    const other = parsed.find((o) => o.e !== null && o.e.name.toLowerCase() === e.account.toLowerCase() && o.e.name.toLowerCase() !== e.name.toLowerCase());
    if (other !== undefined) faults.push(`agents: the account ${e.account} of the entry "${entry}" is the name of the entry "${other.entry}"`);
    const key = e.account.toLowerCase();
    const before = taken.get(key);
    if (before !== undefined) faults.push(`agents: the account ${e.account} is given by the entry "${before}" and by the entry "${entry}"`);
    else taken.set(key, entry);
  }
  return faults;
}

/** #46: the name of each account of the agents, the account in lower case. Read a list that `agentFaults` accepts. */
export function agentAccounts(entries: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of entries) {
    const e = agentEntry(entry);
    if (e !== null && !found.has(e.account.toLowerCase())) found.set(e.account.toLowerCase(), e.name);
  }
  return found;
}

/** #46: the names of the agents: what a session may name itself, when the project lists any. */
export function agentNames(entries: string[]): Set<string> {
  return new Set(entries.flatMap((entry) => agentEntry(entry)?.name ?? []));
}

/** The top-level keys of a YAML file, each with a plain value or a list of plain values. */
export function topLevel(text: string): Map<string, string | string[]> {
  const settings = new Map<string, string | string[]>();
  let list: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "");
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && list) {
      const v = plain(item[1]!);
      if (v !== "") list.push(v);
      continue;
    }
    const match = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!match) {
      if (line.trim() !== "" && !/^\s/.test(line)) list = null;
      continue;
    }
    list = null;
    const key = match[1]!;
    if (settings.has(key)) continue;
    const value = match[2]!.trim();
    if (value === "") {
      list = [];
      settings.set(key, list);
    } else if (value.startsWith("[") && value.endsWith("]")) {
      settings.set(
        key,
        value
          .slice(1, -1)
          .split(",")
          .map(plain)
          .filter((v) => v !== ""),
      );
    } else {
      settings.set(key, plain(value));
    }
  }
  // A key with nothing after it and no list below it has no value.
  for (const [key, value] of settings) if (Array.isArray(value) && value.length === 0) settings.delete(key);
  return settings;
}

export function plain(value: string): string {
  const v = value.trim();
  const quoted = /^"(.*)"$/.exec(v) ?? /^'(.*)'$/.exec(v);
  return quoted ? quoted[1]! : v;
}

/**
 * The agent a session or a script runs for: `$HOWL_ACTOR`, else the first line
 * of `.howl/actor` (a file git ignores). Null when there is neither: then the
 * session is a person's.
 */
export function findActor(root: string, env: Record<string, string | undefined>): string | null {
  const fromEnv = env.HOWL_ACTOR?.trim();
  if (fromEnv) return fromEnv;
  try {
    const line = readFileSync(join(root, ".howl", "actor"), "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "");
    return line ?? null;
  } catch {
    return null;
  }
}
