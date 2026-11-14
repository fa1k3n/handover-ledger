// #74: the target of a shell command is the program it starts, never a part of a value set before it.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { howl, inboxEvents, workspace } from "./helpers.ts";

/** The event `howl hook` leaves for a shell command. */
function eventOf(command: string) {
  const ws = workspace();
  const input = JSON.stringify({
    session_id: "s",
    cwd: ws.root,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_response: {},
  });
  const result = howl(["hook"], { cwd: ws.root, env: ws.env, input });
  assert.equal(result.status, 0, result.stderr);
  const [event] = inboxEvents(ws.inbox);
  assert.ok(event, command);
  return event;
}

const MARK = "MARK74";
/** A command, the target it must give, and that no part of a value is kept. */
function check(command: string, target: string | undefined): void {
  const event = eventOf(command);
  assert.equal(event.data?.target, target, command);
  assert.ok(!JSON.stringify(event).includes(MARK), `nothing of a value: ${command}`);
}

test("a value in quotes that holds a space or a sign is not cut: the program after it is the target", () => {
  check(`AUTH="Bearer ${MARK}abc" curl https://example.invalid`, "curl");
  check(`PGPASSWORD="correct ${MARK} battery" psql -h db`, "psql");
  check(`X="a; ${MARK}" make check`, "make");
  check(`X="a && ${MARK}" make`, "make");
  check(`X="a || ${MARK} b" make`, "make");
  check(`X="a | ${MARK}" make`, "make");
  check(`X='single ${MARK} quoted' ./run.sh`, "run.sh");
  check(`X="with \\"${MARK} inside\\" it" make`, "make");
  check(`X="line\n${MARK} break" make`, "make");
  check(`X=$(printf '%s' "${MARK} a") make`, "make");
  check(`X=\`echo ${MARK} b\` make`, "make");
  check(`X=one\\ ${MARK}\\ two make`, "make");
  check(`A="1 ${MARK}" B='2 ${MARK}' C=3 npm test`, "npm");
  check(`A="1 ${MARK}"\nB="2 ${MARK}"; make`, "make");
  check(`export A="x ${MARK}" && make`, "export");
});

test("what cannot be told safely gives no target", () => {
  check(`X="never closed ${MARK} curl`, undefined);
  check(`X='never closed ${MARK} curl`, undefined);
  check(`X=$(never closed ${MARK} curl`, undefined);
  check(`"$PROGRAM" --flag ${MARK}`, undefined);
  check(`$(which make) ${MARK}`, undefined);
  check(`\`which make\` ${MARK}`, undefined);
  check(`X="only a value ${MARK}"`, undefined);
});

test("a plain program is the target as before, in quotes or not, with its path left out", () => {
  check("ls", "ls");
  check("make check", "make");
  check("./scripts/build.sh --fast", "build.sh");
  check('"/usr/local/bin/my-tool" run', "my-tool");
  check("'/opt/x/tool' run", "tool");
  check("(cd sub && make)", "cd");
  check("  \n  git status", "git");
  check("A=1; B=2 make check", "make");
  check("X=1 && ./scripts/build.sh", "build.sh");
  check('H=/tmp/x/y\nmkdir -p "$H"', "mkdir");
  check("cat a.txt | grep b", "cat");
});
