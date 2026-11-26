// #212: a key's issue or revocation line in the event list carries the same
// signature mark as a signed claim, from a verdict the server gives in
// /api/events by the rule /api/line uses. A claim whose key has no valid issue
// still has none in the list (the owner, 2026-11-26: key lines only).
// @code_class tests
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { signatureMark } from "../src/dashboard/format.ts";
import { texts } from "../src/dashboard/texts.ts";
import { eventHash, fixedForm } from "../src/ledger/fixed.ts";
import { hashLine, type LedgerEvent } from "../src/ledger/ledger.ts";
import { publicOf, signEvent } from "../src/keys/keys.ts";
import { startServer, type Item } from "../src/serve/server.ts";
import { folder } from "./helpers.ts";

function page(): string {
  const dir = folder();
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>dashboard</title>");
  return dir;
}

async function withServer(options: { ledger: string; issuer?: string }, run: (url: string) => Promise<void>) {
  const server = await startServer({ ...options, port: 0, root: page() });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

/**
 * The first line of the signed fixture, then: line 2 a key of agent-1 issued by a new issuer, line 3 a claim it
 * signs, line 4 its revocation (with sig.key forged when asked, #207), line 5 a claim signed by a key never issued.
 */
function keyLedger(options: { forged?: boolean; copy?: boolean } = {}): { ledger: string; issuer: string; stranger: string } {
  const first = (JSON.parse(readFileSync(new URL("./fixtures/ledger-signed.jsonl", import.meta.url), "utf8").split("\n")[0]!) as { event: LedgerEvent }).event;
  const issuer: KeyObject = generateKeyPairSync("ed25519").privateKey;
  const agent: KeyObject = generateKeyPairSync("ed25519").privateKey;
  const stranger: KeyObject = generateKeyPairSync("ed25519").privateKey;
  const by = publicOf(issuer);
  const own = publicOf(agent);
  const base = { v: 0 as const, project: first.project, source: { adapter: "howl-key", kind: "claimed" as const } };
  const claimed = { adapter: "test", kind: "claimed" as const };
  const issued = signEvent(
    { ...base, id: randomUUID(), time: "2026-11-23T14:00:00.000Z", type: "key.issued", data: { key: own.id, public: own.public, actor: "agent-1", from: "2026-11-23T14:00:00.000Z", until: "2026-11-23T22:00:00.000Z", issuer: by.id, issuer_public: by.public } },
    issuer,
  );
  const claim = signEvent(
    { ...base, id: randomUUID(), time: "2026-11-23T14:10:00.000Z", type: "session.started", source: claimed, actor: { kind: "agent", id: "agent-1" }, session: "s1", data: { source: "startup" } },
    agent,
  );
  const revoked = signEvent({ ...base, id: randomUUID(), time: "2026-11-23T14:30:00.000Z", type: "key.revoked", data: { key: own.id, at: "2026-11-23T14:30:00.000Z", issuer: by.id } }, issuer);
  // The signed payload leaves out the whole sig, so the issuer's signature still holds.
  if (options.forged) revoked.sig = { ...revoked.sig!, key: "f".repeat(64) };
  const unknown = signEvent(
    { ...base, id: randomUUID(), time: "2026-11-23T14:40:00.000Z", type: "session.started", source: claimed, actor: { kind: "agent", id: "agent-1" }, session: "s2", data: { source: "startup" } },
    stranger,
  );
  let prev: string | null = null;
  const out: string[] = [];
  // Line 6 when asked: a copy of the claim on line 3, with its id, signed by another key (#199).
  const copy = signEvent({ ...claim, sig: undefined, session: "s3" }, stranger);
  for (const e of [first, issued, claim, revoked, unknown, ...(options.copy ? [copy] : [])]) {
    const text: string = `{"prev":${JSON.stringify(prev)},"hash":"${eventHash(e)}","event":${fixedForm(e).toString("utf8")}}`;
    out.push(text);
    prev = hashLine(Buffer.from(text));
  }
  const ledger = join(folder(), "ledger.jsonl");
  writeFileSync(ledger, out.map((l) => `${l}\n`).join(""));
  return { ledger, issuer: by.id, stranger: publicOf(stranger).id };
}

async function items(url: string): Promise<Item[]> {
  return ((await (await fetch(`${url}/api/events`)).json()) as { events: Item[] }).events;
}

async function lineSignature(url: string, n: number): Promise<{ key: string; ok: boolean; reason?: string } | null> {
  return ((await (await fetch(`${url}/api/line?line=${n}`)).json()) as { signature: { key: string; ok: boolean; reason?: string } | null }).signature;
}

const at = (all: Item[], n: number): Item => {
  const found = all.find((i) => i.n === n);
  assert.ok(found, `line ${n}`);
  return found;
};

test("#212: a key's issue and revocation that hold, with no pin, carry a verdict and the mark issuer not pinned", async () => {
  const { ledger, issuer } = keyLedger();
  await withServer({ ledger }, async (url) => {
    const all = await items(url);
    for (const n of [2, 4]) {
      const it = at(all, n);
      assert.equal(it.signed?.ok, true, `line ${n}`);
      assert.equal(it.signed?.key, issuer, `line ${n} names its issuer`);
      assert.deepEqual(signatureMark(it, false), { kind: "open", glyph: "○", text: texts.stream.signature.open });
    }
  });
});

test("#212: a key's issue and revocation that hold under the pin carry the mark pinned issuer", async () => {
  const { ledger, issuer } = keyLedger();
  await withServer({ ledger, issuer }, async (url) => {
    const all = await items(url);
    for (const n of [2, 4]) {
      const it = at(all, n);
      assert.equal(it.signed?.ok, true, `line ${n}`);
      assert.deepEqual(signatureMark(it, true), { kind: "pinned", glyph: "●", text: texts.stream.signature.pinned });
    }
  });
});

test("#212: under a wrong pin a key's issue does not hold, with the server's reason, and its mark is the fault", async () => {
  const { ledger } = keyLedger();
  await withServer({ ledger, issuer: "e".repeat(64) }, async (url) => {
    const it = at(await items(url), 2);
    assert.equal(it.signed?.ok, false);
    assert.match(it.signed?.reason ?? "", /: not issued by the ledger's issuer$/);
    assert.deepEqual(signatureMark(it, true), { kind: "fault", glyph: "!", text: texts.stream.signature.fault });
  });
});

test("#212: a revocation with a forged sig.key (#207) does not hold, names the issuer it names, and its mark is the fault", async () => {
  const { ledger, issuer } = keyLedger({ forged: true });
  for (const pin of [undefined, issuer]) {
    await withServer({ ledger, issuer: pin }, async (url) => {
      const it = at(await items(url), 4);
      assert.equal(it.signed?.ok, false);
      assert.equal(it.signed?.key, issuer, "data.issuer, never the sig.key the line carries");
      assert.match(it.signed?.reason ?? "", /: the revocation is not signed by the issuer it names; the key is revoked all the same$/);
      assert.equal(signatureMark(it, pin !== undefined).kind, "fault");
    });
  }
});

test("#212: a claim signed by a key with no valid issue still has no verdict in the list; /api/line says why", async () => {
  const { ledger } = keyLedger();
  await withServer({ ledger }, async (url) => {
    const it = at(await items(url), 5);
    assert.equal(it.signed, undefined);
    assert.deepEqual(signatureMark(it, false), { kind: "fault", glyph: "!", text: texts.stream.signature.noIssue });
    const why = await lineSignature(url, 5);
    assert.equal(why?.ok, false);
    assert.match(why?.reason ?? "", /which has no valid issue on a line before$/);
  });
});

test("#212: every verdict in /api/events is the one /api/line gives the line, pin or none, forged or not; every key line has one", async () => {
  for (const forged of [false, true]) {
    const { ledger, issuer } = keyLedger({ forged });
    for (const pin of [undefined, issuer, "e".repeat(64)]) {
      await withServer({ ledger, issuer: pin }, async (url) => {
        const all = await items(url);
        for (const it of all.filter((i) => i.event.type === "key.issued" || i.event.type === "key.revoked")) assert.ok(it.signed, `key line ${it.n} has a verdict`);
        for (const it of all.filter((i) => i.signed !== undefined)) {
          const s = it.signed!;
          const want = await lineSignature(url, it.n!);
          assert.deepEqual({ key: s.key, ok: s.ok, reason: s.reason }, { key: want?.key, ok: want?.ok, reason: want?.reason }, `line ${it.n}, pin ${pin}, forged ${forged}`);
        }
        for (const it of all.filter((i) => i.event.sig === undefined)) assert.equal(it.signed, undefined, `line ${it.n} is not signed`);
      });
    }
  }
});

test("#212 (review, 1): /api/line names the key a copy (#199) carries, never the key of the line it copies", async () => {
  const { ledger, stranger } = keyLedger({ copy: true });
  await withServer({ ledger }, async (url) => {
    const s = await lineSignature(url, 6);
    assert.equal(s?.ok, false);
    assert.equal(s?.key, stranger, "the sig.key of line 6 itself");
    assert.match(s?.reason ?? "", /is already on line 3$/);
  });
});
