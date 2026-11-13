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
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { leave } from "../inbox/inbox.ts";
import { fixedForm } from "../ledger/fixed.ts";
import { inboxPath } from "../ledger/place.ts";
import type { LedgerEvent } from "../ledger/schema.ts";
import { git, originUrl, repoName } from "../howl/git.ts";
import { findActor, findProject } from "../howl/project.ts";
import { parseKeydKey, request } from "../keys/keyd.ts";
import { readKey, signEvent } from "../keys/keys.ts";

type Input = Record<string, unknown>;

/** The notifications that mean the agent waits for a person. */
const WAITS = new Set([
  "permission_prompt",
  "idle_prompt",
  "elicitation_dialog",
  "elicitation_url_dialog",
  "agent_needs_input",
]);

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
        const a = await request(viaKeyd.socket, { op: "sign", key: viaKeyd.key, token: viaKeyd.token, event }, 1500);
        if (a.ok && a.sig) out = { ...event, sig: a.sig as LedgerEvent["sig"] };
      } else {
        out = signEvent(event, readKey(keyFile));
      }
    } catch {
      out = event;
    }
  }
  leave(inboxPath(project.project, env), out);
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
      if (kind === undefined || !WAITS.has(kind)) return null;
      return { type: "agent.waiting", data: { notification_type: kind } };
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
 */
function program(command: string | undefined): string | undefined {
  if (command === undefined) return undefined;
  for (const statement of command.split(/\n|;|&&|\|\|/)) {
    for (const word of statement.trim().split(/\s+/)) {
      if (word === "" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) continue;
      const name = basename(word.replace(/^["'(]+|["')]+$/g, ""));
      return /^[A-Za-z0-9._+-]+$/.test(name) ? name : undefined;
    }
  }
  return undefined;
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
