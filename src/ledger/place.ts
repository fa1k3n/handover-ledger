// Where the ledger of a project lies. Never inside a repository: the place
// depends on the user's environment, never on the working directory.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LedgerError } from "./errors.ts";

/** A project name that is one plain folder name. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

type Env = Record<string, string | undefined>;

/** Whether a name can be a project's: one plain folder name. */
export function isProjectName(name: string): boolean {
  return PROJECT_NAME.test(name) && !name.includes("..");
}

/**
 * The folder of a project: `$HOWL_HOME`, else `$XDG_STATE_HOME/howl`, else
 * `~/.local/state/howl`; in it `<project>`.
 */
export function projectDir(project: string, env: Env = process.env, home: string = homedir()): string {
  if (!isProjectName(project)) {
    throw new LedgerError(
      `${JSON.stringify(project)} is not a project name: use letters, digits, '.', '_' and '-', starting with a letter or digit`,
    );
  }
  return join(howlHome(env, home), project);
}

/** The ledger of a project: `<project folder>/ledger.jsonl`. */
export function ledgerPath(project: string, env: Env = process.env, home: string = homedir()): string {
  return join(projectDir(project, env, home), "ledger.jsonl");
}

/** Where hooks and scripts leave events: `<project folder>/inbox`. */
export function inboxPath(project: string, env: Env = process.env, home: string = homedir()): string {
  return join(projectDir(project, env, home), "inbox");
}

/** Activity, with no chain: `<project folder>/activity.jsonl`. */
export function activityPath(project: string, env: Env = process.env, home: string = homedir()): string {
  return join(projectDir(project, env, home), "activity.jsonl");
}

/** The pseudonyms of the people of a project: `<project folder>/people.json`. Never in the ledger. */
export function peoplePath(project: string, env: Env = process.env, home: string = homedir()): string {
  return join(projectDir(project, env, home), "people.json");
}

/** Where the last round of `howl observe` ended: `<project folder>/observe.json`. */
export function cursorPath(project: string, env: Env = process.env, home: string = homedir()): string {
  return join(projectDir(project, env, home), "observe.json");
}

function howlHome(env: Env, home: string): string {
  if (env.HOWL_HOME) {
    if (!isAbsolute(env.HOWL_HOME)) {
      throw new LedgerError(`HOWL_HOME must be an absolute path, not ${JSON.stringify(env.HOWL_HOME)}`);
    }
    return env.HOWL_HOME;
  }
  // The XDG specification says a relative path is to be ignored.
  if (env.XDG_STATE_HOME && isAbsolute(env.XDG_STATE_HOME)) return join(env.XDG_STATE_HOME, "howl");
  if (!isAbsolute(home)) throw new LedgerError("no home folder to keep the ledger in: set HOWL_HOME");
  return join(home, ".local", "state", "howl");
}
