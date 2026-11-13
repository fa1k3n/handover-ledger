// One howl serve for every project, picked in the page: the tests of issue #15.
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { openLedger } from "../src/ledger/ledger.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder } from "./helpers.ts";

/** A howl home with projects a and b, each with a ledger and one agent of its own, and a folder with no ledger. */
function home(): string {
  const dir = folder();
  for (const [name, agent] of [["a", "agent-a"], ["b", "agent-b"]] as const) {
    mkdirSync(join(dir, name));
    const w = openLedger(join(dir, name, "ledger.jsonl"), { project: name });
    w.append(event({ project: name, type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: agent } }));
    w.close();
  }
  mkdirSync(join(dir, "empty"));
  writeFileSync(join(dir, "not-a-folder.txt"), "x");
  return dir;
}

async function serve(options: { home?: string; ledger?: string; defaultProject?: string }, run: (url: string) => Promise<void>) {
  const server = await startServer({ ...options, port: 0, root: folder() });
  try {
    await run(server.url);
  } finally {
    await server.close();
  }
}

const get = async (url: string) => (await fetch(url)).json() as Promise<Record<string, unknown>>;

test("#15: /api/projects lists the folders with a ledger, and not a folder without one", async () => {
  await serve({ home: home() }, async (url) => {
    const body = (await get(`${url}/api/projects`)) as { projects: { name: string; lines: number }[]; default: string };
    assert.deepEqual(
      body.projects.map((p) => p.name),
      ["a", "b"],
    );
    assert.equal(body.projects[0]!.lines, 2);
    assert.equal(body.default, "a");
    assert.equal((body as { single?: boolean }).single, false, "the page shows the menu, even for one project");
  });
});

test("#15: ?project=b reads b's ledger, not a's; the default is the one asked for", async () => {
  await serve({ home: home(), defaultProject: "b" }, async (url) => {
    const agents = (p: string) => get(`${url}/api/agents${p}`).then((b) => (b.rows as { agent: string }[]).map((r) => r.agent));
    assert.deepEqual(await agents("?project=a"), ["agent-a"]);
    assert.deepEqual(await agents("?project=b"), ["agent-b"]);
    assert.deepEqual(await agents(""), ["agent-b"]);
    assert.equal(((await get(`${url}/api/projects`)) as { default: string }).default, "b");
  });
});

test("#15: ?project=../x, a folder without a ledger and an unknown name give 400", async () => {
  await serve({ home: home() }, async (url) => {
    for (const p of ["..%2Fx", "..", "empty", "nothing", "a%2F..%2Fb"]) {
      assert.equal((await fetch(`${url}/api/events?project=${p}`)).status, 400, p);
    }
  });
});

test("#15: with --ledger, /api/projects gives only that one", async () => {
  const dir = home();
  await serve({ ledger: join(dir, "b", "ledger.jsonl") }, async (url) => {
    const body = (await get(`${url}/api/projects`)) as { projects: { name: string }[]; single: boolean };
    assert.deepEqual(
      body.projects.map((p) => p.name),
      ["b"],
    );
    assert.equal(body.single, true, "one ledger: the page hides the menu");
    assert.equal((await fetch(`${url}/api/agents?project=a`)).status, 400);
  });
});
