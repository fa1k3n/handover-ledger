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

test("the forms of a value a shell knows beyond plain quotes keep nothing either", () => {
  // An array: its elements are a value.
  check(`TOKENS=(${MARK}123 other); make`, "make");
  check(`ARGS=(--token ${MARK}) curl https://example.invalid`, "curl");
  check(`ARGS+=("a ${MARK}" 'b c') make`, "make");
  check(`X+="more ${MARK}" make`, "make");
  // Quotes in the ANSI-C form, where \' does not close.
  check(`A=$'x\\' ${MARK} \\'' ls`, "ls");
  // A backquote that is escaped does not close the substitution.
  check(`X=\`a \\\` ${MARK} \\\`\` make`, "make");
  // Only a space, a tab and a line break part words: other white signs are part of a value.
  check(`X=a\u00a0${MARK} make`, "make");
  check(`X=a\r${MARK} make`, "make");
  check(`X=a\u3000${MARK} make`, "make");
  // The old form of arithmetic.
  check(`X=$[ ${MARK} + 1 ] make`, "make");
  // A redirection before the program: its file is no program.
  check(`2>/dev/null make`, "make");
  check(`>/tmp/x/${MARK} make`, "make");
  check(`> /tmp/x/${MARK} 2>&1 make`, "make");
  check(`< "/tmp/in ${MARK}" make`, "make");
});

test("what a reader this small cannot follow gives no target, and never a part of a value", () => {
  // A `case` inside a substitution: its `)` does not close it.
  check(`X=$(case y in a) ${MARK};; esac) make`, undefined);
  // A here-document before the program.
  check(`<<EOF cat\n${MARK}\nEOF`, undefined);
});

test("a very long command and one nested very deep are read in time, and the event is written", () => {
  const long = `X=${"'a/b'".repeat(40_000)} make`;
  const started = Date.now();
  check(long, "make");
  const took = Date.now() - started;
  const short = Date.now();
  check("make", "make");
  assert.ok(took - (Date.now() - short) < 500, `${took} ms for ${long.length} characters`);
  // Nested deeper than a reader should follow: no target, but the tool call is recorded.
  const deep = `${'X="$('.repeat(5000)}x${')"'.repeat(5000)} make`;
  const event = eventOf(deep);
  assert.equal(event.type, "tool.used");
  assert.equal(event.data?.target, undefined);
  assert.equal(event.data?.outcome, "succeeded");
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

test("an array set before the program is a value: none of its elements is the target", () => {
  check(`PASSWORDS=(${MARK} other) make`, "make");
  check(`A=(one ${MARK}) B=(two three) npm test`, "npm");
  check(`A=("x ${MARK}" 'y z' $(echo ${MARK} q)) make`, "make");
  check(`A=(${MARK}\n  other\n) make`, "make");
  check(`A=(${MARK} other`, undefined);
  check(`A=(${MARK} other)`, undefined);
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
