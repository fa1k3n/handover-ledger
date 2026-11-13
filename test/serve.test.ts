// `howl serve`: the read-only endpoints of the dashboard. The tests of issue #12.
import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { startServer } from "../src/serve/server.ts";
import { folder, rawLines } from "./helpers.ts";
import { writeStory } from "./story.ts";

/** A built page of its own, so the tests do not need a build. */
function page(): string {
  const dir = folder();
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>dashboard</title>");
  writeFileSync(join(dir, "assets", "app.js"), "console.log(1)");
  return dir;
}

async function withServer(ledger: string, run: (url: string) => Promise<void>) {
  const server = await startServer({ ledger, port: 0, root: page() });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

interface Item {
  n?: number;
  from: "ledger" | "activity";
  hash?: string;
  prev?: string | null;
  event: { type: string; id: string };
}

test("#12: /api/agents gives the agent rows, and no person", async () => {
  await withServer(writeStory(), async (url) => {
    const body = (await (await fetch(`${url}/api/agents`)).json()) as { rows: { agent: string; state: string }[]; now: number };
    assert.deepEqual(
      body.rows.map((r) => r.agent),
      ["agent-1"],
    );
    assert.equal(typeof body.now, "number");
  });
});

test("#12: /api/events gives the ledger lines with their number and hashes, and no tool calls unless asked", async () => {
  const ledger = writeStory();
  await withServer(ledger, async (url) => {
    const { events } = (await (await fetch(`${url}/api/events`)).json()) as { events: Item[] };
    assert.equal(events.length, rawLines(ledger).length - 1);
    assert.ok(events.every((e) => e.from === "ledger" && typeof e.n === "number" && typeof e.hash === "string"));
    const second = JSON.parse(rawLines(ledger)[1]!) as { hash: string; prev: string };
    const n2 = events.find((e) => e.n === 2)!;
    assert.equal(n2.hash, second.hash);
    assert.equal(n2.prev, second.prev);

    const all = (await (await fetch(`${url}/api/events?activity=1`)).json()) as { events: Item[] };
    assert.equal(all.events.filter((e) => e.from === "activity").length, 6);
  });
});

test("#12: /api/events after a given line gives only the lines after it", async () => {
  const ledger = writeStory();
  const total = rawLines(ledger).length;
  await withServer(ledger, async (url) => {
    const { events } = (await (await fetch(`${url}/api/events?after=${total - 2}`)).json()) as { events: Item[] };
    assert.deepEqual(
      events.map((e) => e.n),
      [total - 1, total],
    );
  });
});

test("#12: /api/events takes field=value filters, and refuses a wrong one", async () => {
  await withServer(writeStory(), async (url) => {
    const { events } = (await (await fetch(`${url}/api/events?filter=type%3Dreview.*`)).json()) as { events: Item[] };
    assert.equal(events.length, 2);
    const tools = (await (await fetch(`${url}/api/events?filter=type%3Dtool.used`)).json()) as { events: Item[] };
    assert.equal(tools.events.length, 6, "a filter on tool calls reads the activity file");
    assert.equal((await fetch(`${url}/api/events?filter=nonsense`)).status, 400);
  });
});

test("#12: /api/ledger says whether the chain holds and how many lines it has", async () => {
  const ledger = writeStory();
  await withServer(ledger, async (url) => {
    const body = (await (await fetch(`${url}/api/ledger`)).json()) as { ok: boolean; lines: number };
    assert.equal(body.ok, true);
    assert.equal(body.lines, rawLines(ledger).length);
  });
});

test("#12: the page and its files are served, and nothing outside its folder", async () => {
  await withServer(writeStory(), async (url) => {
    assert.match(await (await fetch(url)).text(), /dashboard/);
    assert.equal(await (await fetch(`${url}/assets/app.js`)).text(), "console.log(1)");
    assert.equal((await fetch(`${url}/assets/..%2f..%2fetc%2fpasswd`)).status, 404);
    assert.equal((await fetch(`${url}/nothing.js`)).status, 404);
  });
});

test("#12: the server answers on 127.0.0.1 only, and refuses any other address", async () => {
  const server = await startServer({ ledger: writeStory(), port: 0, root: page() });
  try {
    assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await server.close();
  }
  await assert.rejects(startServer({ ledger: writeStory(), port: 0, root: page(), host: "0.0.0.0" }));
});

test("#12: the server never writes: the ledger and its folder are unchanged", async () => {
  const ledger = writeStory();
  const before = readFileSync(ledger);
  const entries = readdirSync(dirname(ledger)).sort();
  await withServer(ledger, async (url) => {
    await fetch(`${url}/api/agents`);
    await fetch(`${url}/api/events?activity=1`);
    await fetch(`${url}/api/ledger`);
    assert.equal((await fetch(`${url}/api/events`, { method: "POST" })).status, 405);
  });
  assert.deepEqual(readFileSync(ledger), before);
  assert.deepEqual(readdirSync(dirname(ledger)).sort(), entries);
});
