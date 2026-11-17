// The fixed inputs of scripts/bench.sh (#160): ledgers, an inbox and a local code host, made from one seed.
// Nothing here reads the clock or a random source: the same seed gives the same bytes. The lines of a ledger are made
// by `openLedger`, the only place allowed to make them; its first line takes its time and id from the clock and from
// a random source, so both are fixed here before it is loaded.
//
//   node scripts/bench-seed.ts <folder> [--seed <n>] [--sizes 100,10000] [--inbox 1000] [--host 30]
//
// In <folder>: home-<size>/bench/ (ledger.jsonl, activity.jsonl), ingest-base/bench/ (the smallest ledger and an inbox),
// repo/ (.howl/howl.yml and the code host in host/) and manifest.json (a change and a task in each ledger).
// @code_class rules
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PROJECT = "bench";
const START = Date.UTC(2026, 0, 5, 8, 0, 0);

// The first line of a ledger: a time and an id that the seed fixes.
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(START);
    else super(...(args as [number]));
  }
}
globalThis.Date = FixedDate as DateConstructor;
(crypto as unknown as { randomUUID: () => string }).randomUUID = () => "00000000-0000-4000-8000-000000000000";
syncBuiltinESMExports();
const { openLedger } = await import("../src/ledger/ledger.ts");
const { fixedForm } = await import("../src/ledger/fixed.ts");
type Event = Parameters<ReturnType<typeof openLedger>["append"]>[0];

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { seed: { type: "string" }, sizes: { type: "string" }, inbox: { type: "string" }, host: { type: "string" } },
});
const out = positionals[0];
if (out === undefined) throw new Error("usage: bench-seed.ts <folder> [--seed n] [--sizes a,b] [--inbox n] [--host n]");
const seed = Number(values.seed ?? 1);
const sizes = (values.sizes ?? "100,10000,100000").split(",").map(Number);
const inboxFiles = Number(values.inbox ?? 1000);
const hostTasks = Number(values.host ?? 30);

/** mulberry32: a small generator that gives the same numbers for the same seed. */
function generator(s: number) {
  let a = s >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
    pick: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T,
    chance: (p: number) => next() < p,
    hex: (n: number) => Array.from({ length: n }, () => "0123456789abcdef"[Math.floor(next() * 16)]).join(""),
  };
}

const AGENTS = ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5", "agent-6", "agent-7", "agent-8"];
const WORDS = ["ramp", "limit", "watchdog", "table", "valve", "pedal", "fault", "log", "sensor", "filter", "timer", "map"];
const TOOLS = ["Read", "Edit", "Bash", "Grep", "Write", "Glob"];
const FILES = ["src/a.rs", "src/b.rs", "src/control/ramp.rs", "src/hal/mod.rs", "tools/gen.py", "requirements/main.md"];

const at = (ms: number) => new RealDate(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

interface Story {
  ledger: Event[];
  activity: Event[];
  task: string;
  change: string;
}

/** One task from hand-over to merge, with the tool calls of its sessions: what a team's day leaves. */
function story(rng: ReturnType<typeof generator>, n: number, start: number, prefix: string): Story {
  const task = String(n);
  const change = String(n + 1);
  const agent = { kind: "agent" as const, id: rng.pick(AGENTS) };
  const person = { kind: "person" as const, id: `person-${rng.hex(8)}` };
  const reviewer = { kind: "person" as const, id: `person-${rng.hex(8)}` };
  const branch = `task-${task}-${rng.pick(WORDS)}`;
  const session = `s-${prefix}${n}`;
  let k = 0;
  const id = () => `${prefix}${n}-${++k}`;
  let t = start;
  const tick = (minutes: number) => (t += minutes * 60_000);
  const observed = (type: Event["type"], extra: Partial<Event> = {}): Event => ({
    v: 0, id: id(), time: at(t), type, source: { adapter: "local", kind: "observed" }, project: PROJECT, data: { seen: at(t) }, ...extra,
  });
  const claimed = (type: Event["type"], extra: Partial<Event> = {}): Event => ({
    v: 0, id: id(), time: at(t), type, source: { adapter: "claude-code-hook", kind: "claimed" }, project: PROJECT,
    actor: agent, session, branch, ...extra,
  });
  const head = () => rng.hex(40);
  const of = (sha: string) => ({ change, branch, sha, task });
  const ledger: Event[] = [];
  const activity: Event[] = [];
  const work = (calls: number) => {
    for (let i = 0; i < calls; i++) {
      tick(rng.int(1, 3));
      const tool = rng.pick(TOOLS);
      const target = tool === "Bash" ? rng.pick(["cargo", "make", "git", "python3"]) : rng.pick(FILES);
      activity.push(claimed("tool.used", { data: { tool, target, outcome: rng.chance(0.1) ? "failed" : "succeeded" } }));
    }
  };

  ledger.push(observed("task.opened", { task, actor: person }));
  tick(2);
  ledger.push(observed("task.assigned", { task, actor: person, to: agent }));
  tick(1);
  ledger.push(claimed("session.started", { task, data: { source: "startup" } }));
  work(rng.int(3, 8));
  if (rng.chance(0.3)) {
    ledger.push(claimed("agent.waiting", { task, data: { notification_type: "permission_prompt" } }));
    tick(2);
  }
  const a = head();
  tick(3);
  ledger.push(observed("change.opened", { ...of(a), actor: agent }));
  tick(2);
  ledger.push(observed(rng.chance(0.2) ? "checks.failed" : "checks.passed", of(a)));
  let last = a;
  if (rng.chance(0.5)) {
    tick(10);
    ledger.push(observed("review.changes_requested", { ...of(a), actor: reviewer }));
    work(rng.int(2, 5));
    last = head();
    tick(2);
    ledger.push(observed("change.updated", of(last)));
    tick(2);
    ledger.push(observed("checks.passed", of(last)));
  }
  ledger.push(claimed("session.stopped", { task }));
  tick(10);
  ledger.push(observed("review.approved", { ...of(last), actor: reviewer }));
  tick(2);
  ledger.push(observed("change.merged", { ...of(last), actor: person }));
  ledger.push(claimed("session.ended", { task, data: { reason: "other" } }));
  ledger.push(observed("task.closed", { task, actor: person }));
  return { ledger, activity, task, change };
}

/** The stories of a ledger of `lines` lines, in order: the first `lines - 1` events after the first line. */
function ledgerOf(rng: ReturnType<typeof generator>, lines: number, first: number, prefix: string, startAt: number) {
  const ledger: Event[] = [];
  const activity: Event[] = [];
  const stories: Story[] = [];
  let start = startAt;
  for (let n = first; ledger.length < lines; n += 2) {
    const s = story(rng, n, start, prefix);
    stories.push(s);
    for (const e of s.ledger) if (ledger.length < lines) ledger.push(e);
    // The activity of a story is kept while any of its ledger events are.
    activity.push(...s.activity);
    start += rng.int(5, 30) * 60_000;
  }
  return { ledger, activity, stories };
}

const manifest: Record<string, { change: string; task: string }> = {};
for (const size of sizes) {
  const dir = join(out, `home-${size}`, PROJECT);
  mkdirSync(dir, { recursive: true });
  const rng = generator(seed);
  // The first line is the ledger's own: `size` lines in all.
  const { ledger, activity, stories } = ledgerOf(rng, size - 1, 1, "e", START + 60_000);
  const writer = openLedger(join(dir, "ledger.jsonl"), { project: PROJECT });
  for (const e of ledger) writer.append(e);
  writer.close();
  const lines: Buffer[] = activity.map((e) => Buffer.concat([fixedForm(e), Buffer.from("\n")]));
  writeFileSync(join(dir, "activity.jsonl"), Buffer.concat(lines), { mode: 0o600 });
  // The change shown: one in the middle of the ledger, whole.
  const whole = stories.slice(0, -1);
  const middle = whole[Math.floor(whole.length / 2)] ?? stories[0]!;
  manifest[String(size)] = { change: middle.change, task: middle.task };
}

// The base of `howl ingest`: the smallest ledger, and an inbox of files named in the order they were left.
const smallest = Math.min(...sizes);
const base = join(out, "ingest-base", PROJECT);
mkdirSync(join(base, "inbox"), { recursive: true });
copyFileSync(join(out, `home-${smallest}`, PROJECT, "ledger.jsonl"), join(base, "ledger.jsonl"));
copyFileSync(join(out, `home-${smallest}`, PROJECT, "activity.jsonl"), join(base, "activity.jsonl"));
{
  const rng = generator(seed + 1);
  const events: Event[] = [];
  let start = Date.UTC(2026, 5, 1, 8, 0, 0);
  for (let n = 500_001; events.length < inboxFiles; n += 2) {
    const s = story(rng, n, start, "i");
    // A fifth of the files are tool calls, which go to the activity file: spread them through the ledger events.
    for (const e of s.ledger) events.push(e);
    for (const e of s.activity.slice(0, 2)) events.push(e);
    start += rng.int(5, 30) * 60_000;
  }
  events.slice(0, inboxFiles).forEach((e, i) => {
    const name = `${String(1_800_000_000_000 + i).padStart(15, "0")}-${String(i).padStart(8, "0")}-0000-4000-8000-000000000000.json`;
    writeFileSync(join(base, "inbox", name), fixedForm(e), { mode: 0o600 });
  });
}

// The repository of the commands that run in one: the settings, and the code host in a folder of JSON files.
const repo = join(out, "repo");
mkdirSync(join(repo, ".howl"), { recursive: true });
writeFileSync(
  join(repo, ".howl", "howl.yml"),
  `project: ${PROJECT}\nhost: local\nlocal: host\nrepository: bench/bench\nactivity_days: 100000\ntask_from_branch: '^task-([0-9]+)'\nagents:\n${AGENTS.map((a) => `  - ${a}\n`).join("")}`,
);
{
  const rng = generator(seed + 2);
  for (const sub of ["tasks", "changes", "checks"]) mkdirSync(join(repo, "host", sub), { recursive: true });
  let start = START;
  for (let i = 0; i < hostTasks; i++) {
    const t = 100 + i * 2;
    const c = t + 1;
    const who = rng.pick(AGENTS);
    const a = rng.hex(40);
    const b = rng.hex(40);
    const two = rng.chance(0.5);
    const head = two ? b : a;
    const open = at(start + 60 * 60_000);
    const reviewAt = at(start + 120 * 60_000);
    const mergeAt = at(start + 200 * 60_000);
    const reviews = two
      ? [
          { id: `r${c}-1`, by: { login: "reviewer-one" }, state: "changes_requested", at: reviewAt, sha: a },
          { id: `r${c}-2`, by: { login: "reviewer-one" }, state: "approved", at: at(start + 180 * 60_000), sha: b },
        ]
      : [{ id: `r${c}-1`, by: { login: "reviewer-two" }, state: "approved", at: reviewAt, sha: a }];
    const pushes = [{ id: `p${c}-1`, sha: a, at: open, by: { login: who } }];
    if (two) pushes.push({ id: `p${c}-2`, sha: b, at: at(start + 150 * 60_000), by: { login: who }, before: a } as never);
    const files = [rng.pick(FILES), rng.pick(FILES)];
    writeFileSync(
      join(repo, "host", "tasks", `${t}.json`),
      JSON.stringify({
        number: t, openedAt: at(start), openedBy: { login: "lead-dev" },
        assignments: [{ id: `task-${t}-a1`, assignee: { login: who }, by: { login: "lead-dev" }, at: at(start + 5 * 60_000) }],
        closedAt: mergeAt, closedBy: { login: "lead-dev" }, updatedAt: mergeAt,
      }),
    );
    writeFileSync(
      join(repo, "host", "changes", `${c}.json`),
      JSON.stringify({
        number: c, branch: `task-${t}-${rng.pick(WORDS)}`, openedAt: open, openedBy: { login: who },
        head: { sha: head, at: two ? at(start + 150 * 60_000) : open }, tasks: [String(t)], files, reviews, pushes,
        mergedAt: mergeAt, mergedBy: { login: "lead-dev" }, closedAt: mergeAt, closedBy: { login: "lead-dev" }, updatedAt: mergeAt,
      }),
    );
    for (const sha of two ? [a, b] : [a]) {
      writeFileSync(join(repo, "host", "checks", `${sha}.json`), JSON.stringify({ sha, state: "passed", at: at(start + 65 * 60_000) }));
    }
    start += rng.int(5, 30) * 60_000;
  }
}

writeFileSync(join(out, "manifest.json"), JSON.stringify({ seed, sizes, inbox: inboxFiles, host: hostTasks, shown: manifest }, null, 2) + "\n");
