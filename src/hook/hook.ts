// `howl hook`: turns the JSON of a Claude Code hook into an event, handed to
// the writer's server when one runs and left in the inbox otherwise (#64).
//
// Checked against the hooks reference of Claude Code 2.1.323. What matters here:
// - SessionStart adds what a hook prints to the model's context, and exit 2
//   from Stop keeps the session going. So the hook prints nothing and the
//   command always ends with 0; the caller makes sure of that.
// - A failed tool call comes as PostToolUseFailure, not PostToolUse.
// - `model` comes only with SessionStart, and not always; `effort` is `{ level }`.
// - SessionEnd hooks get 1.5 seconds by default.
//
// Only an agent's session is recorded. A tool call keeps the tool, the target
// and the outcome: never the input, the answer or a message, and no hash of the
// input either (#50): a short input can be guessed from a plain hash.
// @code_class recording
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { deliver } from "../inbox/deliver.ts";
import { markDown, recentlyDown } from "../inbox/down.ts";
import { projectDir } from "../ledger/place.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { git, originUrl, repoName } from "../howl/git.ts";
import { findActor, findProject, settingPattern, taskOfBranch } from "../howl/project.ts";
import { parseKeydKey, request } from "../keys/keyd.ts";
import { readKey, signEvent } from "../keys/keys.ts";

type Input = Record<string, unknown>;

/** How long the hook waits for keyd: well within a tool call. */
export const KEYD_TIMEOUT_MS = 500;
/** After keyd failed to answer, how long the hook does not ask it again. */
export const KEYD_PAUSE_MS = 60_000;

/**
 * The notifications that mean the agent waits, and what for in howl's words
 * (#29): a person, who must answer before it goes on, or instructions, when it
 * is done and waits for more. The readers know only howl's words.
 */
const WAITS: Record<string, "person" | "instructions"> = {
  permission_prompt: "person",
  idle_prompt: "instructions",
  elicitation_dialog: "person",
  elicitation_url_dialog: "person",
  agent_needs_input: "person",
};

/**
 * Leaves one event in the inbox for a hook's input, or nothing. Throws on what
 * it cannot do; the caller swallows it, so that the session is never disturbed.
 */
export async function runHook(stdin: string, env: Record<string, string | undefined>, cwd: string): Promise<void> {
  let input: unknown;
  try {
    input = JSON.parse(stdin);
  } catch {
    return;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) return;
  const hook = input as Input;

  const dir = typeof hook.cwd === "string" && isAbsolute(hook.cwd) ? hook.cwd : cwd;
  const built = eventOfHook(hook, env, dir, "claude-code-hook");
  if (!built) return;
  const { project, event } = built;
  // #23: signed with the key of the assignment, when the session has one. A key that cannot be read never stops the hook.
  let out = event;
  const keyFile = named(env.HOWL_KEY);
  if (keyFile !== undefined) {
    try {
      // #24: through keyd, which holds the key, when HOWL_KEY names it; else from a key file.
      const viaKeyd = parseKeydKey(keyFile);
      if (viaKeyd) {
        // #30: a keyd that hangs or is gone never slows a session: after a failure it is not asked for a while.
        const down = join(projectDir(project.project, env), "keyd.down");
        if (!recentlyDown(down, KEYD_PAUSE_MS)) {
          const a = await request(viaKeyd.socket, { op: "sign", key: viaKeyd.key, token: viaKeyd.token, event }, KEYD_TIMEOUT_MS);
          if (a.ok && a.sig) out = { ...event, sig: a.sig as LedgerEvent["sig"] };
          else if (!a.ok && a.unreachable) markDown(down);
        }
      } else {
        out = signEvent(event, readKey(keyFile));
      }
    } catch {
      out = event;
    }
  }
  await deliver(project.project, out, env);
}

/**
 * The event for a hook's JSON (#67: built here for `howl hook`, and by the
 * server for a hook sent to it as it stands). `env` holds what the session
 * names (`HOWL_ACTOR`, `HOWL_TASK`, `HOWL_CHANGE`, `HOWL_ROLE`,
 * `HOWL_ROLE_PROMPT`), `dir` the folder the hook ran in. Null when nothing is
 * recorded: no `.howl/howl.yml` above the folder, no agent, or a hook howl
 * does not record. Nothing of a tool's input or answer is in the event.
 */
export function eventOfHook(
  hook: Record<string, unknown>,
  env: Record<string, string | undefined>,
  dir: string,
  adapter: string,
): { project: NonNullable<ReturnType<typeof findProject>>; event: LedgerEvent } | null {
  const project = findProject(dir);
  if (!project) return null;
  const actor = findActor(project.root, env);
  if (!actor) return null;

  const what = describe(hook, project.root);
  if (!what) return null;

  // #41: a task_from_branch that is no regular expression records nothing, and says nothing.
  let pattern: RegExp | undefined;
  try {
    pattern = settingPattern(project, "task_from_branch");
  } catch {
    return null;
  }
  const where = checkout(dir);
  // The session names its task, else the branch gives it (#41); the event says which (#175).
  const fromEnv = named(env.HOWL_TASK);
  const task = fromEnv ?? taskOfBranch(where.branch, pattern);

  const event: LedgerEvent = {
    v: 0,
    id: randomUUID(),
    time: new Date().toISOString(),
    type: what.type,
    source: { adapter, kind: "claimed" },
    project: project.project,
    actor: { kind: "agent", id: actor },
    session: text(hook.session_id),
    model: text(hook.model),
    effort: effort(hook.effort),
    ...where,
    // Whoever starts the session may name its work: a review in a folder of its own is on the default branch.
    change: named(env.HOWL_CHANGE),
    // Readers take the task from the events, and rank it by where it came from.
    task,
    task_from: task === undefined ? undefined : fromEnv !== undefined ? "env" : "branch",
    role: named(env.HOWL_ROLE),
    prompt: rolePrompt(env.HOWL_ROLE_PROMPT, project.root),
    data: what.data,
  };
  return { project, event };
}

/** The role prompt by its file within the repository and the SHA-256 of its content; none when it cannot be read there. */
function rolePrompt(path: string | undefined, root: string): LedgerEvent["prompt"] {
  const p = named(path);
  if (p === undefined) return undefined;
  const full = resolve(root, p);
  const within = relative(root, full);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) return undefined;
  try {
    // A plain file of a prompt's size only: a pipe in its place would hold the reader up (#67: the server reads it too).
    const stat = statSync(full);
    if (!stat.isFile() || stat.size > MAX_PROMPT) return undefined;
    return { file: within.split(sep).join("/"), sha256: createHash("sha256").update(readFileSync(full)).digest("hex") };
  } catch {
    return undefined;
  }
}

/** The largest role prompt that is hashed. */
const MAX_PROMPT = 1024 * 1024;

/** A value from the environment, trimmed; undefined when empty. */
function named(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function describe(hook: Input, root: string): { type: LedgerEvent["type"]; data?: Record<string, unknown> } | null {
  switch (hook.hook_event_name) {
    case "SessionStart":
      return { type: "session.started", data: only({ source: text(hook.source) }) };
    case "PostToolUse":
      return { type: "tool.used", data: toolCall(hook, root, "succeeded") };
    case "PostToolUseFailure":
      return { type: "tool.used", data: toolCall(hook, root, "failed") };
    case "Notification": {
      const kind = text(hook.notification_type);
      if (kind === undefined || !Object.hasOwn(WAITS, kind)) return null;
      return { type: "agent.waiting", data: { notification_type: kind, waits_for: WAITS[kind] } };
    }
    case "Stop":
      return { type: "session.stopped" };
    case "SessionEnd":
      return { type: "session.ended", data: only({ reason: text(hook.reason) }) };
    default:
      return null;
  }
}

function toolCall(hook: Input, root: string, outcome: string): Record<string, unknown> | undefined {
  const tool = text(hook.tool_name) ?? "unknown";
  const input = typeof hook.tool_input === "object" && hook.tool_input !== null ? (hook.tool_input as Input) : {};
  // Only what a reader shows. Nothing made from the input, and not how long the call took: nothing reads it.
  return only({ tool, target: target(tool, input, root), outcome });
}

/** What a tool call worked on: a path within the repository, or the name of a program. Never content. */
function target(tool: string, input: Input, root: string): string | undefined {
  if (tool === "Bash") return program(text(input.command));
  const path = text(input.file_path) ?? text(input.notebook_path) ?? text(input.path);
  if (path === undefined || !isAbsolute(path)) return undefined;
  const within = relative(root, path);
  if (within === "") return ".";
  if (within.startsWith("..") || isAbsolute(within)) return undefined;
  return within.split(sep).join("/");
}

/**
 * The name of the program a shell command starts, past any variables set before
 * it. A statement that only sets variables (`H=/x` on a line of its own) is
 * passed over for the next one. Undefined when the name cannot be told safely.
 *
 * The command is read word by word as a shell reads it (#74): a value in
 * quotes may hold spaces and signs, and no part of it is ever the program.
 * What this small reader cannot follow gives no target: better none than a
 * part of a value.
 */
function program(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  let at = 0;
  for (;;) {
    // Past the blanks, and the signs between statements and around groups.
    while (at < command.length && /[ \t\n;&|(){}]/.test(command[at]!)) at++;
    if (at >= command.length) return undefined;
    // A comment runs to the end of its line.
    if (command[at] === "#") {
      const line = command.indexOf("\n", at);
      if (line === -1) return undefined;
      at = line;
      continue;
    }
    const word = shellWord(command, at);
    if (word === null) return undefined;
    at = word.end;
    // A redirection before the program (`2>/dev/null`, `> file`, `2>&1`): its file is no program.
    const redirect = /^\d*(<<|<|>>|>)([^]*)$/.exec(word.text);
    if (redirect) {
      // A here-document: its lines follow, and they are content.
      if (redirect[1] === "<<") return undefined;
      if (redirect[2] === "") {
        while (at < command.length && /[ \t&]/.test(command[at]!)) at++;
        const file = shellWord(command, at);
        if (file === null) return undefined;
        at = file.end;
      }
      continue;
    }
    // A word that sets a variable, whatever its value holds.
    const sets = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.exec(word.text);
    if (sets) {
      // An array, `NAME=(a b c)`: the word ends at the `(`, and its elements are values, never the program.
      if (sets[0].length === word.text.length && command[at] === "(") {
        const close = group(command, at + 1, "(", ")", 0);
        if (close === -1) return undefined;
        at = close;
      }
      continue;
    }
    // The program: what stands after the last `/` of the word itself, when that is a plain name.
    const name = word.text.slice(word.slash + 1).replace(/["']/g, "");
    return /^[A-Za-z0-9._+-]+$/.test(name) ? name : undefined;
  }
}

/** Deeper than this a command is not followed: it gives no target. */
const MAX_NESTING = 100;

/**
 * One word of a shell command from `start`: it ends at a blank (a space, a
 * tab, a line break: no other white sign parts words in a shell) or at a sign
 * that stands outside quotes and substitutions. `slash` is the place in the
 * word of its last `/` outside a substitution, or -1. Null when a quote or a
 * substitution does not close: then nothing can be told safely.
 */
function shellWord(s: string, start: number): { text: string; slash: number; end: number } | null {
  let i = start;
  let slash = -1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === " " || c === "\t" || c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") break;
    if (c === "/") slash = i++ - start;
    else if (c === "\\") i += 2;
    else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return null;
      // Between single quotes every sign stands for itself. Only this span is searched, so a long command stays quick.
      for (let k = close - 1; k > i; k--) {
        if (s[k] === "/") {
          slash = k - start;
          break;
        }
      }
      i = close + 1;
    } else if (c === '"') {
      const close = doubleQuoted(s, i + 1, 0, (at) => (slash = at - start));
      if (close === -1) return null;
      i = close;
    } else {
      const close = substitution(s, i, 0);
      if (close === -1) return null;
      i = close > i ? close : i + 1;
    }
  }
  return { text: s.slice(start, Math.min(i, s.length)), slash, end: Math.min(i, s.length) };
}

/** The place after the `"` that closes a text in double quotes that starts at `i`, or -1. */
function doubleQuoted(s: string, i: number, depth: number, onSlash?: (at: number) => void): number {
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') return i + 1;
    if (c === "/") onSlash?.(i);
    if (c === "\\") i += 2;
    else {
      const close = substitution(s, i, depth);
      if (close === -1) return -1;
      i = close > i ? close : i + 1;
    }
  }
  return -1;
}

/**
 * The place after what starts at `i` when that is a substitution or a quote of
 * the `$` kind: `$(…)`, `${…}`, `$[…]`, `` `…` `` or `$'…'`. `i` itself when
 * nothing of the kind starts there, and -1 when it does not close or cannot be
 * followed.
 */
function substitution(s: string, i: number, depth: number): number {
  const c = s[i];
  if (c !== "`" && c !== "$") return i;
  if (depth > MAX_NESTING) return -1;
  // A backquote or `$'…'` ends at its like that no `\` stands before.
  if (c === "`" || s[i + 1] === "'") {
    const shut = c === "`" ? "`" : "'";
    for (let k = c === "`" ? i + 1 : i + 2; k < s.length; k++) {
      if (s[k] === "\\") k++;
      else if (s[k] === shut) return k + 1;
    }
    return -1;
  }
  const next = s[i + 1];
  const shut = next === "(" ? ")" : next === "{" ? "}" : next === "[" ? "]" : null;
  if (shut === null) return i;
  const close = group(s, i + 2, next!, shut, depth + 1);
  // A `case` in a substitution has a `)` that closes nothing: not followed.
  if (close !== -1 && next === "(" && /\bcase\b/.test(s.slice(i + 2, close))) return -1;
  return close;
}

/** The place after the `shut` that closes a group opened before `i`, quotes and substitutions inside it passed over; -1 when it does not close. */
function group(s: string, i: number, open: string, shut: string, depth: number): number {
  let level = 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") i += 2;
    else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return -1;
      i = close + 1;
    } else if (c === '"') {
      i = doubleQuoted(s, i + 1, depth);
      if (i === -1) return -1;
    } else if (c === "`" || c === "$") {
      const close = substitution(s, i, depth);
      if (close === -1) return -1;
      i = close > i ? close : i + 1;
    } else {
      if (c === open) level++;
      else if (c === shut && --level === 0) return i + 1;
      i++;
    }
  }
  return -1;
}

/** The repository's name, branch and head commit, when the folder is a git checkout. */
function checkout(dir: string): Pick<LedgerEvent, "repo" | "branch" | "sha"> {
  const run = (...args: string[]) => git(dir, ...args);
  // One call for the root, the head commit and the branch; a repository with
  // no commit yet has no head, and then only the root is asked for.
  const all = run("rev-parse", "--show-toplevel", "HEAD", "--abbrev-ref", "HEAD")?.split("\n");
  const top = all?.[0] ?? run("rev-parse", "--show-toplevel");
  if (!top) return {};
  const found: Pick<LedgerEvent, "repo" | "branch" | "sha"> = {
    repo: repoName(originUrl(dir)) ?? basename(top),
  };
  if (all && all.length === 3) {
    if (/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(all[1]!)) found.sha = all[1];
    if (all[2] !== "HEAD") found.branch = all[2];
  }
  return found;
}

function effort(value: unknown): string | undefined {
  if (typeof value === "object" && value !== null) return text((value as Input).level);
  return text(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** An object without its undefined members, or undefined when none is left. */
function only(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const kept = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  return Object.keys(kept).length > 0 ? kept : undefined;
}
