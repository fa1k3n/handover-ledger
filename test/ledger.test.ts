// The ledger file and its writer: the tests of issues #1 and #5.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { LedgerError, openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { ledgerPath } from "../src/ledger/place.ts";
import { event, folder, howl, ledgerWith, lines, PROJECT, rawLines, sha256 } from "./helpers.ts";

test("a new ledger starts with ledger.created, mode: trial, prev null", () => {
  const path = ledgerWith(0);
  const all = lines(path);
  assert.equal(all.length, 1);
  const first = all[0]!;
  assert.equal(first.prev, null);
  assert.equal(first.event.type, "ledger.created");
  assert.deepEqual(first.event.data, { mode: "trial" });
  assert.equal(first.event.v, 0);
  assert.equal(first.event.project, PROJECT);
});

test("a line holds exactly prev, hash and event, in that order", () => {
  for (const line of rawLines(ledgerWith(2))) {
    assert.deepEqual(Object.keys(JSON.parse(line)), ["prev", "hash", "event"]);
  }
});

test("opening a ledger that is there adds no first line", () => {
  const path = ledgerWith(2);
  openLedger(path, { project: PROJECT }).close();
  const types = lines(path).map((line) => line.event.type);
  assert.deepEqual(types, ["ledger.created", "task.assigned", "task.assigned"]);
});

test("prev is the SHA-256 of the bytes of the line before; null on the first line", () => {
  const path = ledgerWith(4);
  const raw = rawLines(path);
  assert.equal(raw.length, 5);
  assert.equal(lines(path)[0]!.prev, null);
  for (let i = 1; i < raw.length; i++) {
    assert.equal(JSON.parse(raw[i]!).prev, sha256(raw[i - 1]!), `line ${i + 1}`);
  }
});

test("hash on a written line is the SHA-256 of the fixed form of its event", () => {
  for (const line of lines(ledgerWith(3))) {
    assert.equal(line.hash, sha256(fixedForm(line.event).toString("utf8")));
  }
});

test("the event stands in the line in its fixed form", () => {
  const raw = rawLines(ledgerWith(1))[1]!;
  const written = raw.slice(raw.indexOf('"event":') + '"event":'.length, -1);
  assert.equal(written, fixedForm(JSON.parse(written)).toString("utf8"));
});

test("the same event written to two ledgers has the same hash in both, and a different prev", () => {
  const e = event();
  const a = ledgerWith(0);
  const b = ledgerWith(2);
  for (const path of [a, b]) {
    const writer = openLedger(path, { project: PROJECT });
    writer.append(e);
    writer.close();
  }
  const lastA = lines(a).at(-1)!;
  const lastB = lines(b).at(-1)!;
  assert.equal(lastA.hash, eventHash(e));
  assert.equal(lastA.hash, lastB.hash);
  assert.notEqual(lastA.prev, lastB.prev);
});

test("append returns the hash of the line it wrote: the prev of the next one", () => {
  const path = ledgerWith(0);
  const writer = openLedger(path, { project: PROJECT });
  const head = writer.append(event());
  writer.append(event());
  writer.close();
  assert.equal(lines(path)[2]!.prev, head);
});

test("the chain holds over a line longer than one read", () => {
  const path = ledgerWith(1);
  const writer = openLedger(path, { project: PROJECT });
  writer.append(event({ data: { text: "x".repeat(200_000) } }));
  writer.append(event());
  writer.close();
  const raw = rawLines(path);
  assert.equal(JSON.parse(raw[3]!).prev, sha256(raw[2]!));
  assert.equal(howl(["verify", "--ledger", path]).status, 0);
});

/** Expects `write` to be refused and the ledger to be as it was. */
function refused(write: (append: (e: LedgerEvent) => void) => void): void {
  const path = ledgerWith(2);
  const before = readFileSync(path);
  const writer = openLedger(path, { project: PROJECT });
  try {
    write((e) => assert.throws(() => writer.append(e), LedgerError, JSON.stringify(e)));
  } finally {
    writer.close();
  }
  assert.deepEqual(readFileSync(path), before);
}

test("an event with an unknown field is refused and the file is unchanged", () => {
  refused((append) => {
    append({ ...event(), colour: "red" } as LedgerEvent);
    append(event({ source: { adapter: "test", kind: "observed", extra: 1 } as never }));
  });
});

test("an event that is given with a prev is refused and the file is unchanged", () => {
  refused((append) => {
    append({ ...event(), prev: null } as LedgerEvent);
    append({ ...event(), prev: "0".repeat(64) } as LedgerEvent);
  });
});

test("an event of a type that is not in the list is refused and the file is unchanged", () => {
  refused((append) => {
    for (const type of ["task.asigned", "task", ""]) append(event({ type: type as LedgerEvent["type"] }));
  });
});

test("an event without a field that is always there is refused and the file is unchanged", () => {
  refused((append) => {
    for (const field of ["v", "id", "time", "type", "source", "project"] as const) {
      const without: Partial<LedgerEvent> = event();
      delete without[field];
      append(without as LedgerEvent);
    }
  });
});

test("an event that has no fixed form is refused and the file is unchanged", () => {
  refused((append) => {
    append(event({ task: "\ud800" }));
    append(event({ data: { n: Number.NaN } }));
  });
});

test("an event of another project is refused and the file is unchanged", () => {
  refused((append) => append(event({ project: "another" })));
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
