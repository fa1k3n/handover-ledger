// The ledger file and its writer. The tests of issue #1, in its order.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { LedgerError, openLedger, type NewEvent } from "../src/ledger/ledger.ts";
import { ledgerPath } from "../src/ledger/place.ts";
import { event, folder, howl, ledgerWith, PROJECT, rawLines, sha256 } from "./helpers.ts";

test("a new ledger starts with ledger.created, mode: trial, prev null", () => {
  const path = ledgerWith(0);
  const lines = rawLines(path);
  assert.equal(lines.length, 1);
  const first = JSON.parse(lines[0]!);
  assert.equal(first.type, "ledger.created");
  assert.deepEqual(first.data, { mode: "trial" });
  assert.equal(first.prev, null);
  assert.equal(first.v, 0);
  assert.equal(first.project, PROJECT);
});

test("opening a ledger that is there adds no first line", () => {
  const path = ledgerWith(2);
  openLedger(path, { project: PROJECT }).close();
  const types = rawLines(path).map((line) => JSON.parse(line).type);
  assert.deepEqual(types, ["ledger.created", "task.assigned", "task.assigned"]);
});

test("each later line holds the SHA-256 of the line before", () => {
  const path = ledgerWith(4);
  const lines = rawLines(path);
  assert.equal(lines.length, 5);
  for (let i = 1; i < lines.length; i++) {
    assert.equal(JSON.parse(lines[i]!).prev, sha256(lines[i - 1]!), `line ${i + 1}`);
  }
});

test("the chain holds over a line longer than one read", () => {
  const path = ledgerWith(1);
  const writer = openLedger(path, { project: PROJECT });
  writer.append(event({ data: { text: "x".repeat(200_000) } }));
  writer.append(event());
  writer.close();
  const lines = rawLines(path);
  assert.equal(JSON.parse(lines[3]!).prev, sha256(lines[2]!));
  assert.equal(howl(["verify", "--ledger", path]).status, 0);
});

test("an event with an unknown field is refused and the file is unchanged", () => {
  const path = ledgerWith(2);
  const before = readFileSync(path);
  const writer = openLedger(path, { project: PROJECT });
  assert.throws(() => writer.append({ ...event(), colour: "red" } as NewEvent), LedgerError);
  assert.throws(
    () => writer.append(event({ source: { adapter: "test", kind: "observed", extra: 1 } as never })),
    LedgerError,
  );
  writer.close();
  assert.deepEqual(readFileSync(path), before);
});

test("an event of a type that is not in the list is refused and the file is unchanged", () => {
  const path = ledgerWith(2);
  const before = readFileSync(path);
  const writer = openLedger(path, { project: PROJECT });
  for (const type of ["task.asigned", "task", ""]) {
    assert.throws(() => writer.append(event({ type: type as NewEvent["type"] })), LedgerError, type);
  }
  writer.close();
  assert.deepEqual(readFileSync(path), before);
});

test("an event without a field that is always there is refused and the file is unchanged", () => {
  const path = ledgerWith(2);
  const before = readFileSync(path);
  const writer = openLedger(path, { project: PROJECT });
  for (const field of ["id", "time", "type", "source", "project"] as const) {
    const without: Partial<NewEvent> = event();
    delete without[field];
    assert.throws(() => writer.append(without as NewEvent), LedgerError, field);
  }
  writer.close();
  assert.deepEqual(readFileSync(path), before);
});

test("a second writer is refused while the lock is held, and gets in when it is released", () => {
  const path = ledgerWith(1);
  const first = openLedger(path, { project: PROJECT });
  assert.throws(
    () => openLedger(path, { project: PROJECT }),
    (e: unknown) => e instanceof LedgerError && e.message.includes(`${path}.lock`),
  );
  first.append(event());
  first.close();

  const second = openLedger(path, { project: PROJECT });
  second.append(event());
  second.close();
  assert.equal(rawLines(path).length, 4);
  assert.equal(howl(["verify", "--ledger", path]).status, 0);
});

test("a closed writer writes no more", () => {
  const path = ledgerWith(1);
  const writer = openLedger(path, { project: PROJECT });
  writer.close();
  assert.throws(() => writer.append(event()), LedgerError);
  assert.equal(rawLines(path).length, 2);
});

test("the ledger lands under $HOWL_HOME when it is set, and never under the working directory", () => {
  const home = folder();
  const work = folder();
  const path = ledgerPath(PROJECT, { HOWL_HOME: home }, "/home/nobody");
  assert.equal(path, join(home, PROJECT, "ledger.jsonl"));

  const writer = openLedger(path, { project: PROJECT });
  writer.append(event());
  writer.close();
  assert.ok(existsSync(join(home, PROJECT, "ledger.jsonl")));

  const result = howl(["verify", "--project", PROJECT], { cwd: work, env: { HOWL_HOME: home } });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readdirSync(work), []);
});

test("without $HOWL_HOME the ledger lands under $XDG_STATE_HOME/howl, else ~/.local/state/howl", () => {
  assert.equal(
    ledgerPath(PROJECT, { XDG_STATE_HOME: "/var/state" }, "/home/nobody"),
    join("/var/state", "howl", PROJECT, "ledger.jsonl"),
  );
  assert.equal(
    ledgerPath(PROJECT, {}, "/home/nobody"),
    join("/home/nobody", ".local", "state", "howl", PROJECT, "ledger.jsonl"),
  );
});

test("a place that would follow the working directory is refused", () => {
  // A relative $HOWL_HOME, and a project name that is a path, would both
  // put the ledger wherever the command happens to run.
  assert.throws(() => ledgerPath(PROJECT, { HOWL_HOME: "state" }, "/home/nobody"), LedgerError);
  assert.throws(() => ledgerPath("../elsewhere", { HOWL_HOME: "/var/howl" }, "/home/nobody"), LedgerError);
  assert.throws(() => ledgerPath("a/b", { HOWL_HOME: "/var/howl" }, "/home/nobody"), LedgerError);
});
