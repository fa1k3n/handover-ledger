// Where the ledger of a project lies. Never inside a repository: the place
// depends on the user's environment, never on the working directory.
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { LedgerError } from "./errors.ts";

/** A project name that is one plain folder name. */
const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * `$HOWL_HOME`, else `$XDG_STATE_HOME/howl`, else `~/.local/state/howl`;
 * in it `<project>/ledger.jsonl`.
 */
export function ledgerPath(
  project: string,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  if (!PROJECT_NAME.test(project) || project.includes("..")) {
    throw new LedgerError(
      `${JSON.stringify(project)} is not a project name: use letters, digits, '.', '_' and '-', starting with a letter or digit`,
    );
  }
  return join(howlHome(env, home), project, "ledger.jsonl");
}

function howlHome(env: Record<string, string | undefined>, home: string): string {
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
