// #191: /api/line answers the event dialog in one call: the line as stored,
// its prev and hash, whether the chain is intact to it, the checkpoint that
// covers it and the signature's result. Read only.
// @code_class tests
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { hashLine, openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import { checkSignatures, issueKey, readKey, signEvent } from "../src/keys/keys.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, ledgerWith, lines, PROJECT, rawLines, writeLines } from "./helpers.ts";

/** A built page of its own, so the tests need no build. */
function page(): string {
  const dir = folder();
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>dashboard</title>");
  return dir;
}

async function withServer(options: { ledger?: string; home?: string; project?: string }, run: (url: string) => Promise<void>) {
  const server = await startServer({ ...options, port: 0, root: page() });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

interface Answer {
  item: { n: number; from: string; raw: string; hash: string; prev: string | null; event: LedgerEvent };
  intact: boolean;
  broken: number | null;
  doubted: boolean;
  last: boolean;
  checkpoint: { lines: number; head: string; time: string; holds: boolean } | null;
  signature: { key: string; ok: boolean; reason?: string } | null;
  related: { before: { n: number }[]; after: { n: number }[]; beforeMore: number; afterMore: number };
}

async function line(url: string, n: number | string, project?: string): Promise<{ status: number; body: Answer & { error?: string }; text: string }> {
  const q = new URLSearchParams({ line: String(n) });
  if (project !== undefined) q.set("project", project);
  const res = await fetch(`${url}/api/line?${q}`);
  const text = await res.text();
  return { status: res.status, body: JSON.parse(text), text };
}

test("#191: a line of an intact ledger is intact, with the stored line, its hash and its prev", async () => {
  const ledger = ledgerWith(3);
  const stored = lines(ledger);
  await withServer({ ledger }, async (url) => {
    const a = await line(url, 2);
    assert.equal(a.status, 200);
    assert.equal(a.body.item.n, 2);
    assert.equal(a.body.item.from, "ledger");
    assert.equal(a.body.item.raw, rawLines(ledger)[1]);
    assert.equal(a.body.item.hash, stored[1]!.hash);
    assert.equal(a.body.item.prev, stored[1]!.prev);
    assert.equal(a.body.item.prev, hashLine(Buffer.from(rawLines(ledger)[0]!)));
    assert.equal(a.body.intact, true);
    assert.equal(a.body.broken, null);
    const first = await line(url, 1);
    assert.equal(first.status, 200);
    assert.equal(first.body.item.prev, null, "the first line has no prev");
  });
});

test("#191: a line at or after a break is not intact; a line before it is", async () => {
  const ledger = ledgerWith(5);
  const raws = rawLines(ledger);
  const third = JSON.parse(raws[2]!);
  third.event.task = "changed";
  raws[2] = JSON.stringify(third);
  writeLines(ledger, raws);
  await withServer({ ledger }, async (url) => {
    const before = await line(url, 2);
    assert.equal(before.body.intact, true);
    for (const n of [3, 5]) {
      const a = await line(url, n);
      assert.equal(a.status, 200);
      assert.equal(a.body.intact, false, `line ${n}`);
      assert.equal(a.body.broken, 3, "the line where the chain breaks");
    }
  });
});

/** A ledger with an issued key, a signed event that holds, one changed after it was signed, and one unsigned claim. */
function signedLedger(): string {
  const dir = folder();
  const ledger = join(dir, "ledger.jsonl");
  const issued = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, { configDir: join(dir, "config"), keysDir: join(dir, "keys") }, new Date("2026-01-02T00:00:00Z"));
  const key = readKey(issued.file);
  const claim = (over: Partial<LedgerEvent> = {}) => event({ type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" }, ...over });
  const good = signEvent(claim(), key);
  const changed = { ...signEvent(claim(), key), session: "changed-after-signing" };
  const w = openLedger(ledger, { project: PROJECT });
  w.append(issued.event); // line 2
  w.append(good); // line 3
  w.append(changed); // line 4
  w.append(claim()); // line 5
  w.close();
  return ledger;
}

test("#191: a signed event gives the signature's result: valid, or not with the reason; an unsigned one gives none", async () => {
  await withServer({ ledger: signedLedger() }, async (url) => {
    const good = await line(url, 3);
    assert.equal(good.status, 200);
    assert.equal(good.body.signature?.ok, true);
    assert.match(good.body.signature!.key, /^[0-9a-f]{64}$/);
    const wrong = await line(url, 4);
    assert.equal(wrong.body.signature?.ok, false);
    assert.match(wrong.body.signature!.reason ?? "", /does not hold/);
    const unsigned = await line(url, 5);
    assert.equal(unsigned.body.signature, null);
    const issue = await line(url, 2);
    assert.equal(issue.body.signature?.ok, true, "the issue itself, signed by the issuer key it names");
  });
});

test("#191: a line covered by the checkpoint kept beside the ledger names it; a line after the last has none", async () => {
  const ledger = ledgerWith(5);
  const raws = rawLines(ledger);
  const head = hashLine(Buffer.from(raws[2]!));
  writeFileSync(join(ledger, "..", "anchor.json"), `${JSON.stringify({ at: "2026-01-03T00:00:00.000Z", lines: 3, head })}\n`);
  await withServer({ ledger }, async (url) => {
    for (const n of [1, 3]) {
      const a = await line(url, n);
      assert.deepEqual(a.body.checkpoint, { lines: 3, head, time: "2026-01-03T00:00:00.000Z", holds: true }, `line ${n}`);
    }
    const after = await line(url, 4);
    assert.equal(after.body.checkpoint, null, "no checkpoint covers a line after the last");
  });
});

test("#191: a checkpoint whose head the ledger no longer holds is named, and does not hold", async () => {
  const ledger = ledgerWith(4);
  writeFileSync(join(ledger, "..", "anchor.json"), `${JSON.stringify({ at: "2026-01-03T00:00:00.000Z", lines: 3, head: "0".repeat(64) })}\n`);
  await withServer({ ledger }, async (url) => {
    const a = await line(url, 2);
    assert.equal(a.body.checkpoint?.holds, false);
  });
});

test("#191: without a checkpoint, or with one that cannot be read, no line is covered", async () => {
  const ledger = ledgerWith(2);
  await withServer({ ledger }, async (url) => {
    assert.equal((await line(url, 2)).body.checkpoint, null);
  });
  writeFileSync(join(ledger, "..", "anchor.json"), "not json");
  await withServer({ ledger }, async (url) => {
    const a = await line(url, 2);
    assert.equal(a.status, 200);
    assert.equal(a.body.checkpoint, null);
  });
});

test("#191: a line that is not there gives 404; a line that is no number is refused", async () => {
  const ledger = ledgerWith(2);
  await withServer({ ledger }, async (url) => {
    for (const n of [0, 4, 99]) assert.equal((await line(url, n)).status, 404, `line ${n}`);
    for (const n of ["abc", "-1", "1.5", "../ledger.jsonl", ""]) assert.equal((await line(url, n)).status, 400, `line ${JSON.stringify(n)}`);
    assert.equal((await fetch(`${url}/api/line`)).status, 400, "no line asked for");
  });
});

test("#191: /api/line is read only: a POST is refused", async () => {
  const ledger = ledgerWith(2);
  await withServer({ ledger }, async (url) => {
    const res = await fetch(`${url}/api/line?line=1`, { method: "POST" });
    assert.equal(res.status, 405);
  });
});

/** A howl home with projects a and b, each with a ledger and an agent of its own. */
function home(): string {
  const dir = folder();
  for (const name of ["a", "b"]) {
    mkdirSync(join(dir, name));
    const w = openLedger(join(dir, name, "ledger.jsonl"), { project: name });
    w.append(event({ project: name, type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: `agent-${name}` } }));
    w.close();
  }
  return dir;
}

test("#191: /api/line reads only a project the server serves, never a path", async () => {
  const dir = home();
  await withServer({ home: dir, project: "a" }, async (url) => {
    const own = await line(url, 2, "a");
    assert.equal(own.status, 200);
    assert.equal(own.body.item.event.actor?.id, "agent-a");
    const other = await line(url, 2, "b");
    assert.equal(other.status, 404);
    assert.ok(!other.text.includes("agent-b"), "nothing of the other project's ledger");
    for (const p of ["../a", "a/../b", "/etc", ".."]) {
      const a = await line(url, 2, p);
      assert.ok(a.status === 404 || a.status === 400, `project ${p}: ${a.status}`);
      assert.ok(!a.text.includes("agent-"), `project ${p}: nothing of a ledger`);
    }
  });
  await withServer({ home: dir }, async (url) => {
    assert.equal((await line(url, 2, "b")).body.item.event.actor?.id, "agent-b", "a server of every project reads the one named");
    const bad = await line(url, 2, "../b");
    assert.equal(bad.status, 400);
    assert.ok(!bad.text.includes("agent-"));
  });
});

test("#191: /api/line gives the related events of the line's task, before and after it", async () => {
  const dir = folder();
  const ledger = join(dir, "ledger.jsonl");
  const w = openLedger(ledger, { project: PROJECT });
  w.append(event({ task: "7" })); // 2
  w.append(event({ task: "8" })); // 3
  w.append(event({ task: "7" })); // 4
  w.append(event({ task: "7" })); // 5
  w.close();
  await withServer({ ledger }, async (url) => {
    const a = await line(url, 4);
    assert.deepEqual(
      a.body.related.before.map((r) => r.n),
      [2],
    );
    assert.deepEqual(
      a.body.related.after.map((r) => r.n),
      [5],
    );
  });
});

test("#191 (review): a line changed with its hash made again is not intact, nor is the checkpoint that covers it", async () => {
  const ledger = ledgerWith(5);
  const raws = rawLines(ledger);
  const head5 = hashLine(Buffer.from(raws[4]!));
  const third = JSON.parse(raws[2]!);
  third.event.task = "forged";
  third.hash = eventHash(third.event);
  raws[2] = JSON.stringify(third);
  writeLines(ledger, raws);
  writeFileSync(join(ledger, "..", "anchor.json"), `${JSON.stringify({ at: "2026-01-03T00:00:00.000Z", lines: 5, head: head5 })}\n`);
  await withServer({ ledger }, async (url) => {
    const changed = await line(url, 3);
    assert.equal(changed.body.broken, 4, "the check fails at line 4: its prev");
    assert.equal(changed.body.intact, false, "line 4 does not hold line 3's hash: line 3 may have been changed");
    assert.equal(changed.body.doubted, true);
    assert.equal(changed.body.checkpoint?.holds, false, "the head matches, but the chain up to it is broken");
    const before = await line(url, 2);
    assert.equal(before.body.intact, true);
    assert.equal(before.body.doubted, false);
    assert.equal(before.body.checkpoint?.holds, false, "a checkpoint holds only when the chain is intact up to its line count");
    const at = await line(url, 4);
    assert.equal(at.body.intact, false);
    assert.equal(at.body.doubted, false);
  });
});

test("#191 (review): the last line is said to be the last; a checkpoint over an intact chain holds", async () => {
  const ledger = ledgerWith(3);
  const raws = rawLines(ledger);
  writeFileSync(join(ledger, "..", "anchor.json"), `${JSON.stringify({ at: "2026-01-03T00:00:00.000Z", lines: 4, head: hashLine(Buffer.from(raws[3]!)) })}\n`);
  await withServer({ ledger }, async (url) => {
    const last = await line(url, 4);
    assert.equal(last.body.intact, true);
    assert.equal(last.body.last, true);
    assert.equal(last.body.checkpoint?.holds, true);
    assert.equal((await line(url, 3)).body.last, false);
  });
});

test("#191 (review): a line number past a safe integer is refused", async () => {
  const ledger = ledgerWith(1);
  await withServer({ ledger }, async (url) => {
    assert.equal((await line(url, "9999999999999999")).status, 400);
    assert.equal((await line(url, "999999999999999")).status, 404);
  });
});

/** The review's D1: the signed ledger of the fixtures, then a copy of its signed claim on line 3 with data changed, the same id and sig. */
function copiedClaim(): { ledger: string; events: LedgerEvent[] } {
  const events = readFileSync(new URL("./fixtures/ledger-signed.jsonl", import.meta.url), "utf8")
    .trim()
    .split("\n")
    .map((l) => (JSON.parse(l) as { event: LedgerEvent }).event);
  events.push({ ...events[2]!, data: { source: "resume" } });
  let prev: string | null = null;
  const out: string[] = [];
  for (const e of events) {
    const text: string = `{"prev":${JSON.stringify(prev)},"hash":"${eventHash(e)}","event":${fixedForm(e).toString("utf8")}}`;
    out.push(text);
    prev = hashLine(Buffer.from(text));
  }
  const ledger = join(folder(), "ledger.jsonl");
  writeFileSync(ledger, out.map((l) => `${l}\n`).join(""));
  return { ledger, events };
}

test("#199 (second look): a changed copy of a signed claim, with the same id and sig, is never read as valid", async () => {
  const { ledger, events } = copiedClaim();
  const id = events[2]!.id;
  const repeat = `the event ${id} is already on line 3`;
  const check = checkSignatures(events.map((event, i) => ({ n: i + 1, event })));
  assert.equal(check.byEvent.get(id)?.ok, false, "keyed by id, the repeated id is not valid");
  assert.equal(check.byEvent.get(id)?.reason, repeat);
  await withServer({ ledger }, async (url) => {
    // The dashboard's items: the copy on line 6 is not valid; the claim on line 3 is.
    const items = ((await (await fetch(`${url}/api/events`)).json()) as { events: { n: number; signed?: { ok: boolean; reason?: string } }[] }).events;
    assert.equal(items.find((i) => i.n === 6)?.signed?.ok, false, "the copy");
    assert.equal(items.find((i) => i.n === 6)?.signed?.reason, repeat);
    assert.equal(items.find((i) => i.n === 3)?.signed?.ok, true, "the claim itself");
    // /api/line: item.signed agrees with the signature of the line.
    const copy = await line(url, 6);
    const signed = (copy.body.item as { signed?: { ok: boolean } }).signed;
    assert.equal(signed?.ok, false);
    assert.equal(copy.body.signature?.ok, false);
    const first = await line(url, 3);
    assert.equal((first.body.item as { signed?: { ok: boolean } }).signed?.ok, true);
  });
});
