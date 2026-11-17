// `howl serve` shows one project unless asked for more, and answers only a request meant for it. The tests of issue #54.
// @code_class tests
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openLedger } from "../src/ledger/ledger.ts";
import { startServer } from "../src/serve/server.ts";
import { event, folder } from "./helpers.ts";

const CLI = fileURLToPath(new URL("../src/cli/howl.ts", import.meta.url));

/** A howl home with projects a and b, each with a ledger and one agent of its own. */
function home(): string {
  const dir = folder();
  for (const [name, agent] of [["a", "agent-a"], ["b", "agent-b"]] as const) {
    mkdirSync(join(dir, name));
    const w = openLedger(join(dir, name, "ledger.jsonl"), { project: name });
    w.append(event({ project: name, type: "session.started", source: { adapter: "test", kind: "claimed" }, actor: { kind: "agent", id: agent } }));
    w.close();
  }
  return dir;
}

/** A built page of its own, so the tests need no build. */
function page(): string {
  const dir = folder();
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>dashboard</title>");
  return dir;
}

async function serve(options: { project?: string; defaultProject?: string }, run: (url: string, port: number) => Promise<void>) {
  const server = await startServer({ ...options, home: home(), port: 0, root: page() });
  try {
    await run(server.url, Number(new URL(server.url).port));
  } finally {
    await server.close();
  }
}

interface Answer {
  status: number;
  body: string;
}

/** A GET with the headers given, as `fetch` cannot set a Host. */
function get(url: string, path: string, headers: Record<string, string> = {}): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = request({ host: u.hostname, port: u.port, path, method: "GET", headers }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

const names = (answer: Answer) => (JSON.parse(answer.body) as { projects: { name: string }[] }).projects.map((p) => p.name);

/** Nothing of either ledger: not an agent, not a project's name as a value. */
function assertNoLedger(answer: Answer, what: string) {
  assert.ok(!answer.body.includes("agent-a") && !answer.body.includes("agent-b"), `${what}: the answer holds nothing of a ledger`);
}

test("R54.1: started for one project, /api/projects lists that project only", async () => {
  await serve({ project: "a" }, async (url) => {
    assert.deepEqual(names(await get(url, "/api/projects")), ["a"]);
  });
});

test("R54.2: started for one project, ?project=<other> gives 404 and nothing of the other's ledger", async () => {
  await serve({ project: "a" }, async (url) => {
    for (const path of ["/api/agents?project=b", "/api/events?project=b", "/api/ledger?project=b", "/api/events?project=b&activity=1"]) {
      const answer = await get(url, path);
      assert.equal(answer.status, 404, path);
      assert.ok(!answer.body.includes("agent-b"), `${path}: nothing of b's ledger`);
    }
  });
});

test("R54.2: guard: started for one project, its own name is still answered", async () => {
  await serve({ project: "a" }, async (url) => {
    const answer = await get(url, "/api/agents?project=a");
    assert.equal(answer.status, 200);
    assert.match(answer.body, /agent-a/);
    assert.equal((await get(url, "/api/agents")).status, 200, "with no ?project, the one project");
  });
});

test("R54.3: guard: started for every project, /api/projects lists every project of the home", async () => {
  await serve({ defaultProject: "a" }, async (url) => {
    assert.deepEqual(names(await get(url, "/api/projects")), ["a", "b"]);
    assert.equal((await get(url, "/api/agents?project=b")).status, 200);
  });
});

/** Runs `howl serve` with `args` and stops it after `ms` or when `until` is satisfied by its output. */
function runServe(args: string[], cwd: string, home: string, until: (out: string) => boolean, ms = 4000) {
  return new Promise<{ status: number | null; stdout: string; stderr: string; stopped: boolean }>((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "serve", "--port", "0", ...args], { cwd, env: { PATH: process.env.PATH ?? "", HOWL_HOME: home } });
    let stdout = "";
    let stderr = "";
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill("SIGTERM");
    };
    const timer = setTimeout(stop, ms);
    child.stdout.on("data", (d) => {
      stdout += d;
      if (until(stdout)) stop();
    });
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, stopped });
    });
  });
}

test("R54.3: `howl serve --all` says on its first line that it serves every project", async () => {
  const run = await runServe(["--all"], folder(), home(), (out) => out.includes("\n"));
  assert.match(run.stdout.split("\n")[0]!, /every project/, `first line; stderr: ${run.stderr}`);
});

test("R54.4: a Host that is not one of the three with the server's own port gives 403 and nothing of a ledger", async () => {
  for (const options of [{ project: "a" }, { defaultProject: "a" }]) {
    await serve(options, async (url, port) => {
      const hosts = ["evil.example", `evil.example:${port}`, "127.0.0.1", "localhost", `127.0.0.1:${port + 1}`, `localhost:${port + 1}`, `[::1]:${port + 1}`, `0.0.0.0:${port}`, `127.0.0.2:${port}`];
      for (const host of hosts) {
        for (const path of ["/", "/api/projects", "/api/agents", "/api/events", "/api/ledger"]) {
          const answer = await get(url, path, { host });
          assert.equal(answer.status, 403, `Host ${host} for ${path}`);
          assertNoLedger(answer, `Host ${host} for ${path}`);
        }
      }
    });
  }
});

test("R54.5: guard: a Host of 127.0.0.1, localhost or [::1] with the server's port is answered as today", async () => {
  await serve({ defaultProject: "a" }, async (url, port) => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const projects = await get(url, "/api/projects", { host });
      assert.equal(projects.status, 200, host);
      assert.deepEqual(names(projects), ["a", "b"], host);
      const index = await get(url, "/", { host });
      assert.equal(index.status, 200, host);
      assert.match(index.body, /dashboard/, host);
    }
  });
});

test("R54.6: an Origin that is not http:// and one of the three hosts gives 403", async () => {
  await serve({ defaultProject: "a" }, async (url, port) => {
    const origins = ["http://evil.example", `http://evil.example:${port}`, "null", `https://127.0.0.1:${port}`, `https://localhost:${port}`];
    for (const origin of origins) {
      for (const path of ["/", "/api/projects", "/api/agents"]) {
        const answer = await get(url, path, { host: `127.0.0.1:${port}`, origin });
        assert.equal(answer.status, 403, `Origin ${origin} for ${path}`);
        assertNoLedger(answer, `Origin ${origin} for ${path}`);
      }
    }
  });
});

test("R54.6: guard: an Origin of http:// and one of the three hosts, or no Origin, is answered as today", async () => {
  await serve({ defaultProject: "a" }, async (url, port) => {
    for (const origin of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`]) {
      assert.equal((await get(url, "/api/projects", { host: `127.0.0.1:${port}`, origin })).status, 200, origin);
    }
    assert.equal((await get(url, "/api/projects", { host: `127.0.0.1:${port}` })).status, 200, "no Origin");
  });
});

test("R54.7: `howl serve` with no --ledger, --project, --all and no howl.yml above ends not with 0 and names --project and --all", async () => {
  const run = await runServe([], folder(), home(), () => false);
  assert.equal(run.stopped, false, "it ends by itself and serves nothing");
  assert.notEqual(run.status, 0);
  const said = run.stdout + run.stderr;
  assert.match(said, /--project/);
  assert.match(said, /--all/);
});

test("R54.8: started for one project, /api/projects says one project is served, so the page shows no menu", async () => {
  await serve({ project: "a" }, async (url) => {
    const body = JSON.parse((await get(url, "/api/projects")).body) as { single: boolean };
    assert.equal(body.single, true);
  });
});

test("R54.8: guard: started for every project, /api/projects says several are served, so the page shows the menu", async () => {
  await serve({ defaultProject: "a" }, async (url) => {
    const body = JSON.parse((await get(url, "/api/projects")).body) as { single: boolean };
    assert.equal(body.single, false);
  });
});
