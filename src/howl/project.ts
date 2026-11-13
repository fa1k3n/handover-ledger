// The project of a working directory, from the nearest .howl/howl.yml above it,
// and the agent a session runs for.
//
// howl.yml is read with a small reader of its own, not a YAML library: only the
// top-level `key: value` lines are read, and everything indented is passed over.
// That is all this step needs, and it keeps the hook quick and free of dependencies.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProjectName } from "../ledger/place.ts";

export interface Project {
  /** The folder that holds `.howl/`. */
  root: string;
  project: string;
  /** How many days activity is kept. */
  activityDays: number;
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
  const project = settings.get("project");
  if (project === undefined || !isProjectName(project)) return null;
  let activityDays = DEFAULT_ACTIVITY_DAYS;
  const days = settings.get("activity_days");
  if (days !== undefined) {
    if (!/^[1-9][0-9]*$/.test(days)) return null;
    activityDays = Number(days);
  }
  return { root, project, activityDays };
}

/** The top-level `key: value` lines of a YAML file, with comments and quotes taken away. */
function topLevel(text: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.replace(/(^|\s)#.*$/, "").trim();
    const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value);
    if (quoted) value = quoted[1]!;
    if (value !== "" && !settings.has(match[1]!)) settings.set(match[1]!, value);
  }
  return settings;
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
