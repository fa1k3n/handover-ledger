// #202: the dashboard and /api/line say whether a signature holds against a pinned issuer or only against the issuer the
// ledger names, as `howl verify` does since #199. The pin is `howl up --issuer` and `howl serve --issuer`; without it
// nothing is pinned and nothing reads as known.
// @code_class tests
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { barIssuer, decodedFields, partIdentity } from "../src/dashboard/format.ts";
import { texts } from "../src/dashboard/texts.ts";
import { issueKey, readKey, revokeKey, signEvent } from "../src/keys/keys.ts";
import { openLedger, type LedgerEvent } from "../src/ledger/ledger.ts";
import type { Item } from "../src/serve/server.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder, howl, PROJECT, startHowl, workspace } from "./helpers.ts";
import { observed, until, up } from "./up-helpers.ts";

/** A built page of its own, so the tests need no build. */
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

interface Answer {
  issuer: { id: string | null; pinned: boolean };
  signature: { key: string; ok: boolean; reason?: string } | null;
  item: { signed?: { ok: boolean; reason?: string } };
}

async function line(url: string, n: number): Promise<{ status: number; body: Answer }> {
  const res = await fetch(`${url}/api/line?line=${n}`);
  return { status: res.status, body: (await res.json()) as Answer };
}

const claim = (over: Partial<LedgerEvent> = {}) => event({ type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" }, ...over });

/**
 * A ledger whose one key is issued by a new issuer of its own, with one claim signed by that key: line 2 is the key's
 * issue, line 3 the claim, line 4 an unsigned claim.
 */
function ledgerOfIssuer(): { ledger: string; issuer: string } {
  const dir = folder();
  const ledger = join(dir, "ledger.jsonl");
  const issued = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, { configDir: join(dir, "config"), keysDir: join(dir, "keys") }, new Date("2026-01-02T00:00:00Z"));
  const w = openLedger(ledger, { project: PROJECT });
  w.append(issued.event);
  w.append(signEvent(claim(), readKey(issued.file)));
  w.append(claim());
  w.close();
  return { ledger, issuer: issued.issuerId };
}

/** The pin of an issuer that is not the ledger's. */
const OTHER = "0".repeat(64);

test("#202: /api/line without --issuer says the issuer is not pinned, and which issuer the ledger names", async () => {
  const { ledger, issuer } = ledgerOfIssuer();
  await withServer({ ledger }, async (url) => {
    for (const n of [2, 3, 4]) assert.deepEqual((await line(url, n)).body.issuer, { id: issuer, pinned: false }, `line ${n}`);
    assert.equal((await line(url, 3)).body.signature?.ok, true, "the signature holds against the issuer the ledger names");
  });
});

test("#202: /api/line with --issuer says the issuer is pinned, and which", async () => {
  const { ledger, issuer } = ledgerOfIssuer();
  await withServer({ ledger, issuer }, async (url) => {
    for (const n of [2, 3, 4]) assert.deepEqual((await line(url, n)).body.issuer, { id: issuer, pinned: true }, `line ${n}`);
    assert.equal((await line(url, 3)).body.signature?.ok, true);
    assert.equal((await line(url, 2)).body.signature?.ok, true, "the key's own issue holds against the pin");
  });
});

test("#202: a ledger with no key line names no issuer, and a pin is the issuer all the same", async () => {
  const dir = folder();
  const ledger = join(dir, "ledger.jsonl");
  const w = openLedger(ledger, { project: PROJECT });
  w.append(claim());
  w.close();
  await withServer({ ledger }, async (url) => assert.deepEqual((await line(url, 2)).body.issuer, { id: null, pinned: false }));
  await withServer({ ledger, issuer: OTHER }, async (url) => assert.deepEqual((await line(url, 2)).body.issuer, { id: OTHER, pinned: true }));
});

test("#202: a ledger with a forged issuer under a pin: the signature is not valid in /api/line, and in the list, as in verify", async () => {
  // The forger's issuer is the one the ledger names; the real issuer is the pin.
  const forged = ledgerOfIssuer();
  const real = ledgerOfIssuer().issuer;
  assert.notEqual(forged.issuer, real);
  await withServer({ ledger: forged.ledger, issuer: real }, async (url) => {
    const key = await line(url, 2);
    assert.equal(key.body.signature?.ok, false, "the key's issue names an issuer that is not the pin");
    assert.match(key.body.signature?.reason ?? "", /not issued by the ledger's issuer/);
    const signed = await line(url, 3);
    assert.equal(signed.body.signature?.ok, false);
    assert.match(signed.body.signature?.reason ?? "", /has no valid issue on a line before/);
    assert.deepEqual(signed.body.issuer, { id: real, pinned: true });
    const items = ((await (await fetch(`${url}/api/events`)).json()) as { events: Item[] }).events;
    assert.equal(items.find((i) => i.n === 3)?.signed, undefined, "no key is taken, so the list has no verdict of a key to show");
  });
  // And the same ledger without a pin: the forger's own issuer is taken, and the signature is valid, with no pin said.
  await withServer({ ledger: forged.ledger }, async (url) => {
    const signed = await line(url, 3);
    assert.equal(signed.body.signature?.ok, true);
    assert.deepEqual(signed.body.issuer, { id: forged.issuer, pinned: false });
  });
});

test("#202: under a pin that is the ledger's issuer, the list gives the signature as valid, as without it", async () => {
  const { ledger, issuer } = ledgerOfIssuer();
  await withServer({ ledger, issuer }, async (url) => {
    const items = ((await (await fetch(`${url}/api/events`)).json()) as { events: Item[] }).events;
    assert.equal(items.find((i) => i.n === 3)?.signed?.ok, true);
  });
});

test("#202: /api/ledger says whether the issuer is pinned, for the status bar, in both answers", async () => {
  const { ledger, issuer } = ledgerOfIssuer();
  await withServer({ ledger }, async (url) => assert.equal(((await (await fetch(`${url}/api/ledger`)).json()) as { pinned: boolean }).pinned, false));
  await withServer({ ledger, issuer }, async (url) => assert.equal(((await (await fetch(`${url}/api/ledger`)).json()) as { pinned: boolean }).pinned, true));
  const broken = join(folder(), "ledger.jsonl");
  writeFileSync(broken, "not a ledger\n");
  for (const pin of [undefined, issuer]) {
    await withServer({ ledger: broken, issuer: pin }, async (url) => {
      const body = (await (await fetch(`${url}/api/ledger`)).json()) as { ok: boolean; pinned: boolean };
      assert.equal(body.ok, false);
      assert.equal(body.pinned, pin !== undefined);
    });
  }
});

test("#202: startServer refuses a pin that is not 64 lowercase hex digits", async () => {
  const { ledger } = ledgerOfIssuer();
  for (const pin of ["abc", "A".repeat(64), "g".repeat(64), `${"0".repeat(64)}\n`, ""]) {
    await assert.rejects(startServer({ ledger, issuer: pin, port: 0, root: page() }), { message: /--issuer must be a key id: 64 hex digits/ }, JSON.stringify(pin));
  }
});

test("#202: howl serve and howl up refuse a bad pin as howl verify does: the same words, usage, status 2, before anything starts", () => {
  const { ledger } = ledgerOfIssuer();
  const home = folder();
  for (const args of [["serve", "--ledger", ledger, "--issuer", "abc"], ["serve", "--all", "--issuer", "ABC"], ["up", "--issuer", "abc"]]) {
    const r = howl(args, { env: { HOWL_HOME: home } });
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^howl: --issuer must be a key id: 64 hex digits\n\nusage:/, args.join(" "));
    assert.equal(r.stdout, "", "nothing started");
  }
  const v = howl(["verify", "--ledger", ledger, "--issuer", "abc"]);
  assert.equal(v.status, 2);
  assert.match(v.stderr, /^howl: --issuer must be a key id: 64 hex digits\n\nusage:/, "the same refusal of verify");
});

test("#202: the usage names --issuer on up and serve", () => {
  const r = howl(["help"]);
  assert.match(r.stdout, /howl up \[.*--issuer <fingerprint>.*\]/);
  assert.match(r.stdout, /howl serve \[.*--issuer <fingerprint>.*\]/);
});

test("#202: the status bar says issuer pinned or not pinned, and nothing before the ledger is read", () => {
  assert.equal(barIssuer({ ok: true, lines: 3, head: "h", trial: false, pinned: true }), "issuer pinned");
  assert.equal(barIssuer({ ok: true, lines: 3, head: "h", trial: false, pinned: false }), "issuer not pinned");
  assert.equal(barIssuer({ ok: false, lines: 3, line: 2, faults: [], pinned: true }), "issuer pinned", "also when the chain is broken");
  assert.equal(barIssuer({ ok: false, lines: 3, line: 2, faults: [], pinned: false }), "issuer not pinned");
  assert.equal(barIssuer(null), null, "not read yet: nothing is said");
  assert.equal(texts.stream.bar.pinned, "issuer pinned");
  assert.equal(texts.stream.bar.notPinned, "issuer not pinned");
});

const PIN = "d".repeat(64);
const sent = (type: LedgerEvent["type"]) => event({ type, source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: "agent-1" } });
const asItem = (e: LedgerEvent) => ({ from: "ledger", n: 3, hash: "h", prev: "p", event: e, raw: "{}" }) as Item;

test("#202: part 3 says valid for the key under the pinned issuer, with the pin whole", () => {
  const key = "a".repeat(64);
  const id = partIdentity(asItem(sent("session.started")), { key, ok: true }, { id: PIN, pinned: true });
  assert.equal(id.signature, `valid for key aaaaaaaaaaaa, under the pinned issuer ${PIN}`);
  assert.match(id.limit!, /stays a claim/);
  assert.match(id.limit!, /sent with that key, unchanged since/);
  assert.match(id.limit!, /the pin this server was started with \(--issuer\)/);
  assert.doesNotMatch(id.limit!, /does not show that the issuer/, "under a pin the limit is not that of the unpinned");
});

test("#202: part 3 says valid for the key under the issuer the ledger names (not pinned), and never reads as known", () => {
  const key = "a".repeat(64);
  const id = partIdentity(asItem(sent("session.started")), { key, ok: true }, { id: "e".repeat(64), pinned: false });
  assert.equal(id.signature, "valid for key aaaaaaaaaaaa, under the issuer the ledger names (not pinned)");
  assert.doesNotMatch(id.signature, /pinned issuer|trusted|known/i);
  assert.match(id.limit!, /does not show that the issuer is one kept apart from the ledger/);
  assert.match(id.limit!, /stays a claim/);
});

test("#202: part 3 for a key's issue or revocation says the same of its issuer, in both cases", () => {
  const key = "b".repeat(64);
  for (const type of ["key.issued", "key.revoked"] as const) {
    const it = asItem(sent(type));
    assert.equal(partIdentity(it, { key, ok: true }, { id: PIN, pinned: true }).signature, `valid for the issuer key this line names (bbbbbbbbbbbb), under the pinned issuer ${PIN}`, type);
    const open = partIdentity(it, { key, ok: true }, { id: key, pinned: false }).signature;
    assert.equal(open, "valid for the issuer key this line names (bbbbbbbbbbbb), under the issuer the ledger names (not pinned)", type);
    assert.doesNotMatch(open, /earlier line|pinned issuer/, type);
  }
});

test("#202: part 3 for a signature that is not valid says why, under a pin or not, and never says pinned issuer", () => {
  const key = "a".repeat(64);
  for (const issuer of [{ id: PIN, pinned: true }, { id: null, pinned: false }]) {
    const id = partIdentity(asItem(sent("session.started")), { key, ok: false, reason: "signed by key aaaaaaaaaaaa, which has no valid issue on a line before" }, issuer);
    assert.equal(id.signature, "not valid: signed by key aaaaaaaaaaaa, which has no valid issue on a line before");
    assert.match(id.limit!, issuer.pinned ? /the pin this server was started with/ : /does not show that the issuer/);
  }
});

test("#202: part 3 for an unsigned event or a tool call says nothing of the issuer", () => {
  for (const issuer of [{ id: PIN, pinned: true }, { id: null, pinned: false }]) {
    const unsigned = partIdentity(asItem(sent("session.started")), null, issuer);
    assert.equal(unsigned.signature, "not signed");
    assert.equal(unsigned.limit, null);
    const tool = partIdentity({ ...asItem(sent("tool.used")), from: "activity" } as Item, undefined, issuer);
    assert.equal(tool.signature, texts.provenance.identity.tool);
  }
});

test("#202: howl up --issuer starts a server that holds signatures to the pin, and without it nothing is pinned", async () => {
  for (const pin of [undefined, "a".repeat(64)]) {
    const running = await up(observed(), pin === undefined ? [] : ["--issuer", pin]);
    try {
      const body = (await (await fetch(`${running.url}/api/ledger`)).json()) as { pinned: boolean };
      assert.equal(body.pinned, pin !== undefined, `up ${pin ?? "without a pin"}`);
      // #202 (review, 6): its start line says whether it holds a pin, and which.
      const start = await until(() => running.output().split("\n").find((l) => l.startsWith("howl up: ")), 10_000, "the start line");
      assert.match(start, pin === undefined ? /; issuer not pinned\)$/ : new RegExp(`; issuer pinned: ${pin}\\)$`), start);
    } finally {
      await running.stop();
    }
  }
});

test("#202: howl serve --issuer starts a server that holds signatures to the pin, and without it nothing is pinned", async () => {
  const { ledger, issuer } = ledgerOfIssuer();
  for (const pin of [undefined, issuer]) {
    const child = startHowl(["serve", "--port", "0", "--ledger", ledger, ...(pin === undefined ? [] : ["--issuer", pin])], { env: { HOWL_HOME: folder() } });
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = "";
        child.stdout.on("data", (d) => {
          out += d;
          const m = /^howl serve: (http:\/\/127\.0\.0\.1:\d+) .*$/m.exec(out);
          if (!m) return;
          // #202 (review, 6): the start line says whether it holds a pin, and which.
          assert.match(m[0], pin === undefined ? /, issuer not pinned\)$/ : new RegExp(`, issuer pinned: ${pin}\\)$`), m[0]);
          resolve(m[1]!);
        });
        child.on("close", (status) => reject(new Error(`howl serve ended with ${status}`)));
      });
      const answer = await line(url, 3);
      assert.deepEqual(answer.body.issuer, { id: issuer, pinned: pin !== undefined });
      assert.equal(answer.body.signature?.ok, true);
    } finally {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("close", resolve));
    }
  }
});

/** The key's issue, then its revocation with the issuer's signature but another `sig.key` (the review's forged-revocation ledger): line 2 and line 3. */
function ledgerOfForgedRevocation(): { ledger: string; issuer: string } {
  const dir = folder();
  const ledger = join(dir, "ledger.jsonl");
  const places = { configDir: join(dir, "config"), keysDir: join(dir, "keys") };
  const issued = issueKey(PROJECT, { actor: "agent-1", hours: 24 }, places, new Date("2026-01-02T00:00:00Z"));
  const revoked = revokeKey(PROJECT, issued.keyId, places, new Date("2026-01-02T01:00:00Z"));
  const w = openLedger(ledger, { project: PROJECT });
  w.append(issued.event);
  w.append({ ...revoked, sig: { key: "f".repeat(64), value: revoked.sig!.value } });
  w.close();
  return { ledger, issuer: issued.issuerId };
}

test("#202 (review, 1): part 7's valid row says under which issuer, pinned or not; never a bare valid", async () => {
  const { ledger, issuer } = ledgerOfIssuer();
  for (const pin of [undefined, issuer]) {
    await withServer({ ledger, issuer: pin }, async (url) => {
      const a = (await (await fetch(`${url}/api/line?line=3`)).json()) as Answer & { item: Item };
      const row = decodedFields(a.item, "UTC", a.issuer).find((f) => f.k === "Signature")?.v ?? "";
      assert.match(row, /^valid · key [0-9a-f]{12} · agent-1 · until /);
      if (pin === undefined) {
        assert.match(row, / · issuer not pinned$/);
        assert.doesNotMatch(row, /pinned issuer/);
      } else {
        assert.ok(row.endsWith(` · pinned issuer ${issuer}`), row);
      }
    });
  }
});

test("#202 (review, 1): part 7's valid row says the issuer is not read yet before the answer of /api/line; a signature that does not hold names no issuer", () => {
  const base = { from: "ledger", n: 3, hash: "h", prev: "p", raw: "{}", event: { ...sent("session.started"), sig: { key: "c".repeat(64), value: "v" } } };
  const signed = { key: "c".repeat(64), actor: "agent-1", until: "2026-11-13T17:00:00Z" };
  const row = (item: object, issuer?: { id: string | null; pinned: boolean }) => decodedFields(item as Item, "UTC", issuer).find((f) => f.k === "Signature")?.v;
  assert.match(row({ ...base, signed: { ...signed, ok: true } })!, / · issuer not read yet$/);
  assert.equal(row({ ...base, signed: { ...signed, ok: false, reason: "signed after the key was revoked" } }, { id: PIN, pinned: true }), "does not hold: signed after the key was revoked");
  assert.equal(row({ ...base, signed: undefined }), "does not hold: its key has no valid issue on a line before");
});

test("#202 (review, 2): under a pin, a key issued by another issuer reads as having no valid issue on a line before, in part 7 as in part 3 and verify", async () => {
  const forged = ledgerOfIssuer();
  const real = ledgerOfIssuer().issuer;
  await withServer({ ledger: forged.ledger, issuer: real }, async (url) => {
    const a = (await (await fetch(`${url}/api/line?line=3`)).json()) as Answer & { item: Item };
    assert.equal(a.item.signed, undefined);
    assert.equal(decodedFields(a.item, "UTC", a.issuer).find((f) => f.k === "Signature")?.v, "does not hold: its key has no valid issue on a line before");
    assert.match(a.signature?.reason ?? "", /has no valid issue on a line before/);
  });
});

test("#202 (review, 3): part 3 names the issuer the line holds (data.issuer) for a key's revocation, never the sig.key it carries", async () => {
  const { ledger, issuer } = ledgerOfForgedRevocation();
  for (const pin of [undefined, issuer]) {
    await withServer({ ledger, issuer: pin }, async (url) => {
      const a = (await (await fetch(`${url}/api/line?line=3`)).json()) as Answer & { item: Item };
      // #207: the answer names data.issuer too, and the forged sig.key is a fault on the line; the key is still revoked.
      assert.equal(a.signature?.key, issuer, "the answer names the issuer the line names, never the sig.key it carries");
      const id = partIdentity(a.item, a.signature, a.issuer).signature;
      assert.ok(!id.includes("ffffffffffff"), id);
      assert.match(id, /^not valid: revocation of key [0-9a-f]{12}: the revocation is not signed by the issuer it names; the key is revoked all the same$/);
    });
  }
});

test("#202 (review, 3): part 3 for a key line without a readable data.issuer falls back to the key the line carries", () => {
  const it = asItem({ ...sent("key.revoked"), data: {} });
  assert.match(partIdentity(it, { key: "b".repeat(64), ok: true }, { id: null, pinned: false }).signature, /\(bbbbbbbbbbbb\)/);
});

test("#202 (review, 4): howl serve --all refuses --issuer: a pin holds one project's issuer; usage, status 2, nothing started", () => {
  const r = howl(["serve", "--all", "--issuer", PIN], { env: { HOWL_HOME: folder() } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^howl: --issuer pins one project's issuer, and --all serves every project: serve one project, or leave the pin out\n\nusage:/);
  assert.equal(r.stdout, "");
});

test("#202 (review, 4): howl up refuses --issuer when the home holds more than one project; usage, status 2, nothing written", () => {
  const ws = workspace();
  mkdirSync(join(ws.home, "other"));
  openLedger(join(ws.home, "other", "ledger.jsonl"), { project: "other" }).close();
  const r = howl(["up", "--issuer", PIN], { cwd: ws.root, env: ws.env });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /^howl: --issuer pins one project's issuer, and howl up shows every project of the home \(example, other\): start it without --issuer, or with a home that holds this project alone\n\nusage:/);
  assert.equal(r.stdout, "");
  assert.equal(existsSync(ws.ledger), false, "the writer was never started");
});

test("#202 (review, 4): the usage says a pin holds one project's issuer", () => {
  assert.match(howl(["help"]).stdout, /--issuer .* one project/s);
});
