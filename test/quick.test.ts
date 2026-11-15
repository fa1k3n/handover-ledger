// #85: the dashboard stays quick on a ledger of thousands of lines.
// @code_class tests
import assert from "node:assert/strict";
import { appendFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { oneAtATime } from "../src/dashboard/format.ts";
import type { LedgerEvent } from "../src/ledger/schema.ts";
import { actingAgents } from "../src/read/acting.ts";
import { Kept } from "../src/serve/kept.ts";
import { folder, PROJECT } from "./helpers.ts";

const T0 = Date.UTC(2026, 0, 1, 8, 0, 0);
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString();

test("#85: actingAgents reads a time at most once per event, and gives what it gave", () => {
  const events: LedgerEvent[] = [];
  for (let i = 0; i < 500; i++) {
    // A session of one agent on the branch, a minute before the change is opened through a person's account.
    events.push({
      v: 0,
      id: `s-${i}`,
      time: at(i * 20 - 1),
      type: "session.started",
      source: { adapter: "claude-code-hook", kind: "claimed" },
      project: PROJECT,
      actor: { kind: "agent", id: `agent-${i % 3}` },
      session: `session-${i}`,
      branch: `task-${i}`,
    });
    events.push({
      v: 0,
      id: `h-${i}`,
      time: at(i * 20),
      type: "change.opened",
      source: { adapter: "github", kind: "observed" },
      project: PROJECT,
      actor: { kind: "person", id: "person-0c0c0c0c" },
      change: String(i),
      branch: `task-${i}`,
    });
  }
  const parse = Date.parse;
  let calls = 0;
  Date.parse = (text: string) => {
    calls++;
    return parse(text);
  };
  let found: ReturnType<typeof actingAgents>;
  try {
    found = actingAgents(events);
  } finally {
    Date.parse = parse;
  }
  assert.ok(calls <= events.length, `${calls} readings of a time for ${events.length} events`);
  assert.equal(found.size, 500);
  for (let i = 0; i < 500; i++) assert.deepEqual(found.get(`h-${i}`), { agent: `agent-${i % 3}`, via: "person-0c0c0c0c" });
});

test("#85: what is kept of a file is made once while the file is unchanged, and again when it changed", () => {
  const file = join(folder(), "ledger.jsonl");
  writeFileSync(file, "one\n");
  const kept = new Kept<number>();
  let made = 0;
  const get = () => kept.of(file, () => ++made);

  assert.equal(get(), 1);
  assert.equal(get(), 1, "unchanged: not made again");

  appendFileSync(file, "two\n");
  assert.equal(get(), 2, "a line was appended");
  assert.equal(get(), 2);

  // Replaced by a file of the same size: its time of change tells.
  writeFileSync(file, "ONE\nTWO\n");
  const s = statSync(file);
  utimesSync(file, s.atime, new Date(s.mtimeMs + 5000));
  assert.equal(get(), 3, "the same size, changed later");
  assert.equal(get(), 3);
});

test("#85: a file that is not there is not kept: what is made for it is made each time", () => {
  const kept = new Kept<string>();
  let made = 0;
  const missing = join(folder(), "activity.jsonl");
  assert.equal(kept.of(missing, () => `made ${++made}`), "made 1");
  assert.equal(kept.of(missing, () => `made ${++made}`), "made 2");
  writeFileSync(missing, "x\n");
  assert.equal(kept.of(missing, () => `made ${++made}`), "made 3");
  assert.equal(kept.of(missing, () => `made ${++made}`), "made 3", "once it is there it is kept");
});

test("#85: the poll skips a round while the last call has not answered", async () => {
  let started = 0;
  let answer: (() => void) | undefined;
  const call = oneAtATime(
    () =>
      new Promise<void>((resolve) => {
        started++;
        answer = resolve;
      }),
  );
  call();
  call();
  call();
  assert.equal(started, 1, "the first has not answered yet");
  answer!();
  await new Promise((r) => setImmediate(r));
  call();
  assert.equal(started, 2, "after the answer the next round asks again");

  // A call that fails frees the next round as well.
  let failing = 0;
  const failed = oneAtATime(() => {
    failing++;
    return Promise.reject(new Error("no answer"));
  });
  failed();
  await new Promise((r) => setImmediate(r));
  failed();
  assert.equal(failing, 2);

  // A call that gives no promise is made at every round, as before.
  let plain = 0;
  const each = oneAtATime(() => {
    plain++;
  });
  each();
  each();
  assert.equal(plain, 2);
});
