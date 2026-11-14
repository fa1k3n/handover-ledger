// howl observe --since: the first round starts at a date. The tests of issue #6, against the local adapter.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { folder, howl, lines, PROJECT, workspace, type Workspace } from "./helpers.ts";
import { at, LocalHost, SHA } from "./local-host.ts";

function setup(): { ws: Workspace; host: LocalHost } {
  const dir = folder();
  const ws = workspace({ yml: `project: ${PROJECT}\nhost: local\nlocal: ${dir}\nrepository: team/product\n` });
  return { ws, host: new LocalHost(dir) };
}
const observe = (ws: Workspace, ...args: string[]) => howl(["observe", "--once", ...args], { cwd: ws.root, env: ws.env });
const events = (ws: Workspace) => (existsSync(ws.ledger) ? lines(ws.ledger).map((l) => l.event as Record<string, any>) : []);
const task = (n: number, minute: number) => ({ number: n, openedAt: at(minute), openedBy: { login: "alice" }, assignments: [], updatedAt: at(minute) });

test("#6: without observe.json, --since passes over what was updated before the date and writes what came after", () => {
  const { ws, host } = setup();
  host.task(task(1, 0)).task(task(2, 120));
  const r = observe(ws, "--since", at(60));
  assert.equal(r.status, 0, r.stderr);
  const tasks = events(ws).filter((e) => e.type === "task.opened").map((e) => e.task);
  assert.deepEqual(tasks, ["2"]);
});

test("#6: --since now writes nothing of what is there, and the next change after it is written", async () => {
  const { ws, host } = setup();
  host.task(task(1, 0));
  assert.equal(observe(ws, "--since", "now").status, 0);
  assert.deepEqual(events(ws).filter((e) => e.type === "task.opened"), []);
  host.task({ ...task(3, 0), updatedAt: new Date(Date.now() + 1000).toISOString() });
  assert.equal(observe(ws).status, 0);
  assert.deepEqual(events(ws).filter((e) => e.type === "task.opened").map((e) => e.task), ["3"]);
});

test("#6: with observe.json --since is refused with status 2 and writes nothing", () => {
  const { ws } = setup();
  assert.equal(observe(ws).status, 0);
  const before = events(ws).length;
  const r = observe(ws, "--since", "2026-01-01");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /observe\.json/);
  assert.equal(events(ws).length, before);
});

test("#6: a date that cannot be read is refused with status 2", () => {
  const { ws } = setup();
  assert.equal(observe(ws, "--since", "last tuesday").status, 2);
  assert.ok(!existsSync(ws.ledger) || events(ws).length === 0);
});

test("#6: the first round writes one observe.started with data.since; later rounds none; howl verify passes", () => {
  const { ws, host } = setup();
  host.task(task(1, 0));
  assert.equal(observe(ws, "--since", "2026-01-01").status, 0);
  assert.equal(observe(ws).status, 0);
  const started = events(ws).filter((e) => e.type === "observe.started");
  assert.equal(started.length, 1);
  assert.equal(started[0]!.data.since, "2026-01-01T00:00:00.000Z");
  void SHA;
  void writeFileSync;
  assert.equal(howl(["verify", "--project", PROJECT], { env: ws.env }).status, 0);
});
