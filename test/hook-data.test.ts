// #50: a tool call keeps nothing that nobody reads, and nothing its input can be guessed from.
// @code_class tests
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixedForm } from "../src/ledger/fixed.ts";
import { howl, inboxEvents, workspace, type Workspace } from "./helpers.ts";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

function input(ws: Workspace, name: string, extra: Record<string, unknown>): string {
  return JSON.stringify({ session_id: "session-1", transcript_path: "/nowhere/t.jsonl", cwd: ws.root, hook_event_name: name, ...extra });
}

/** The event `howl hook` leaves for one hook. */
function eventOf(name: string, extra: Record<string, unknown>) {
  const ws = workspace();
  const result = howl(["hook"], { cwd: ws.root, env: ws.env, input: input(ws, name, extra) });
  assert.equal(result.status, 0, result.stderr);
  const [event] = inboxEvents(ws.inbox);
  assert.ok(event, `${name} leaves an event`);
  return event;
}

const TOOL_INPUT = { command: "ls", description: "list" };
/** Every hook howl records, with every value Claude Code may send beside it. */
const HOOKS: [string, Record<string, unknown>][] = [
  ["SessionStart", { source: "startup", model: "model-a" }],
  ["PostToolUse", { tool_name: "Bash", tool_input: TOOL_INPUT, tool_response: { stdout: "a b" }, tool_use_id: "t1", duration_ms: 1234 }],
  ["PostToolUseFailure", { tool_name: "Read", tool_input: { file_path: "/x" }, error: "no", tool_use_id: "t2", duration_ms: 12 }],
  ["Notification", { message: "Claude needs your permission", notification_type: "permission_prompt" }],
  ["Stop", { stop_hook_active: false, last_assistant_message: "done" }],
  ["SessionEnd", { reason: "prompt_input_exit" }],
];

test("a tool call's event holds the tool, the target and the outcome, and no value made from its input", () => {
  const event = eventOf("PostToolUse", HOOKS[1]![1]);
  assert.deepEqual(event.data, { tool: "Bash", target: "ls", outcome: "succeeded" });
  const failed = eventOf("PostToolUseFailure", HOOKS[2]![1]);
  assert.deepEqual(failed.data, { tool: "Read", outcome: "failed" });
  // Not the hash that was kept before, and no other hash of the input a reader could test a guess against.
  const text = JSON.stringify(event);
  const guesses = [fixedForm(TOOL_INPUT), Buffer.from(JSON.stringify(TOOL_INPUT)), Buffer.from("ls")];
  for (const guess of guesses) {
    for (const algorithm of ["sha256", "sha1", "md5", "sha512"]) {
      const digest = createHash(algorithm).update(guess).digest();
      assert.ok(!text.includes(digest.toString("hex")) && !text.includes(digest.toString("base64")), algorithm);
    }
  }
  assert.ok(!/[0-9a-f]{32,}/.test(JSON.stringify(event.data)), "nothing that looks like a hash in the data");
});

test("the time a tool call took is not kept", () => {
  for (const [name, extra] of [HOOKS[1]!, HOOKS[2]!]) {
    const event = eventOf(name, extra);
    assert.ok(!("duration_ms" in (event.data ?? {})), name);
  }
});

function sources(dir: string): string {
  return readdirSync(dir)
    .filter((name) => /\.tsx?$/.test(name))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .join("\n");
}

test("no data key of a hook's event is unread: each is named by a reader under src/read or src/dashboard", () => {
  const keys = new Set<string>();
  for (const [name, extra] of HOOKS) for (const key of Object.keys(eventOf(name, extra).data ?? {})) keys.add(key);
  assert.deepEqual([...keys].sort(), ["notification_type", "outcome", "reason", "source", "target", "tool", "waits_for"]);
  const readers = `${sources(join(SRC, "read"))}\n${sources(join(SRC, "dashboard"))}`;
  // Read as `data.key`, `data?.key` or `d.key`: the forms the readers use for what belongs to one type of event.
  const unread = [...keys].filter((key) => !new RegExp(`\\b(data|d)\\??\\.${key}\\b`).test(readers));
  assert.deepEqual(unread, []);
});
