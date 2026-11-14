// `howl hook`: turns the JSON of a Claude Code hook into an event in the inbox.
//
// Checked against the hooks reference of Claude Code 2.1.323. What matters here:
// - SessionStart adds what a hook prints to the model's context, and exit 2
//   from Stop keeps the session going. So the hook prints nothing and the
//   command always ends with 0; the caller makes sure of that.
// - A failed tool call comes as PostToolUseFailure, not PostToolUse.
// - `model` comes only with SessionStart, and not always; `effort` is `{ level }`.
// - SessionEnd hooks get 1.5 seconds by default.
//
// Only an agent's session is recorded. A tool call keeps the tool, the target,
// the outcome and a hash of the input: never the input, the answer or a message.
// @code_class recording
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { leave } from "../inbox/inbox.ts";
import { fixedForm } from "../ledger/fixed.ts";
import { inboxPath, projectDir } from "../ledger/place.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { git, originUrl, repoName } from "../howl/git.ts";
import { findActor, findProject } from "../howl/project.ts";
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
  const project = findProject(dir);
  if (!project) return;
  const actor = findActor(project.root, env);
  if (!actor) return;

  const what = describe(hook, project.root);
  if (!what) return;

  const event: LedgerEvent = {
    v: 0,
    id: randomUUID(),
    time: new Date().toISOString(),
    type: what.type,
    source: { adapter: "claude-code-hook", kind: "claimed" },
    project: project.project,
    actor: { kind: "agent", id: actor },
    session: text(hook.session_id),
    model: text(hook.model),
    effort: effort(hook.effort),
    ...checkout(dir),
    // Whoever starts the session may name its work: a review in a folder of its own is on the default branch.
    change: named(env.HOWL_CHANGE),
    task: named(env.HOWL_TASK),
    role: named(env.HOWL_ROLE),
    prompt: rolePrompt(env.HOWL_ROLE_PROMPT, project.root),
    data: what.data,
  };
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
        if (!recentlyDown(down)) {
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
  leave(inboxPath(project.project, env), out);
}

/** Whether keyd failed to answer within the pause; a file that cannot be read is no failure. */
function recentlyDown(file: string): boolean {
  try {
    const at = Date.parse(readFileSync(file, "utf8").trim());
    return Number.isFinite(at) && Date.now() - at < KEYD_PAUSE_MS;
  } catch {
    return false;
  }
}

function markDown(file: string): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${new Date().toISOString()}\n`);
  } catch {
    // The hook never fails over this: keyd is asked again the next time.
  }
}

/** The role prompt by its file within the repository and the SHA-256 of its content; none when it cannot be read there. */
function rolePrompt(path: string | undefined, root: string): LedgerEvent["prompt"] {
  const p = named(path);
  if (p === undefined) return undefined;
  const full = resolve(root, p);
  const within = relative(root, full);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) return undefined;
  try {
    return { file: within.split(sep).join("/"), sha256: createHash("sha256").update(readFileSync(full)).digest("hex") };
  } catch {
    return undefined;
  }
}

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
  let inputHash: string | undefined;
  try {
    inputHash = createHash("sha256").update(fixedForm(input)).digest("hex");
  } catch {
    // An input with no fixed form gets no hash.
  }
  return only({
    tool,
    target: target(tool, input, root),
    outcome,
    input_sha256: inputHash,
    duration_ms: typeof hook.duration_ms === "number" && Number.isFinite(hook.duration_ms) ? hook.duration_ms : undefined,
  });
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
 */
function program(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  let at = 0;
  for (;;) {
    // Past the spaces, and the signs between statements and around groups.
    while (at < command.length && /[\s;&|(){}]/.test(command[at]!)) at++;
    if (at >= command.length) return undefined;
    const word = shellWord(command, at);
    if (word === null) return undefined;
    at = word.end;
    // A word that sets a variable, whatever its value holds.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)) continue;
    // The program: what stands after the last `/` of the word itself, when that is a plain name.
    const name = word.text.slice(word.slash + 1).replace(/["']/g, "");
    return /^[A-Za-z0-9._+-]+$/.test(name) ? name : undefined;
  }
}

/**
 * One word of a shell command from `start`: it ends at a space or a sign that
 * stands outside quotes and substitutions. `slash` is the place in the word of
 * its last `/` outside a substitution, or -1. Null when a quote or a
 * substitution does not close: then nothing can be told safely.
 */
function shellWord(s: string, start: number): { text: string; slash: number; end: number } | null {
  let i = start;
  let slash = -1;
  while (i < s.length) {
    const c = s[i]!;
    if (/[\s;&|()]/.test(c)) break;
    if (c === "/") slash = i - start;
    if (c === "\\") i += 2;
    else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return null;
      // Between single quotes every sign stands for itself.
      const last = s.lastIndexOf("/", close);
      if (last > i) slash = last - start;
      i = close + 1;
    } else if (c === '"') {
      const close = doubleQuoted(s, i + 1, (at) => (slash = at - start));
      if (close === -1) return null;
      i = close;
    } else if (c === "`" || (c === "$" && (s[i + 1] === "(" || s[i + 1] === "{"))) {
      const close = substitution(s, i);
      if (close === -1) return null;
      i = close;
    } else i++;
  }
  return { text: s.slice(start, Math.min(i, s.length)), slash, end: Math.min(i, s.length) };
}

/** The place after the `"` that closes a text in double quotes that starts at `i`, or -1. */
function doubleQuoted(s: string, i: number, onSlash?: (at: number) => void): number {
  while (i < s.length) {
    const c = s[i]!;
    if (c === '"') return i + 1;
    if (c === "/") onSlash?.(i);
    if (c === "\\") i += 2;
    else if (c === "`" || (c === "$" && (s[i + 1] === "(" || s[i + 1] === "{"))) {
      i = substitution(s, i);
      if (i === -1) return -1;
    } else i++;
  }
  return -1;
}

/** The place after a substitution that starts at `i`: `$(…)`, `${…}` or `` `…` ``; -1 when it does not close. */
function substitution(s: string, i: number): number {
  if (s[i] === "`") {
    const close = s.indexOf("`", i + 1);
    return close === -1 ? -1 : close + 1;
  }
  const [open, shut] = s[i + 1] === "(" ? ["(", ")"] : ["{", "}"];
  let depth = 1;
  i += 2;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\") i += 2;
    else if (c === "'") {
      const close = s.indexOf("'", i + 1);
      if (close === -1) return -1;
      i = close + 1;
    } else if (c === '"') {
      i = doubleQuoted(s, i + 1);
      if (i === -1) return -1;
    } else {
      if (c === open) depth++;
      else if (c === shut && --depth === 0) return i + 1;
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
