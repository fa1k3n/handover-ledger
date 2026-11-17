// The event log drops an answer to a question the reader has changed: the tests of issue #93.
// @code_class tests
import assert from "node:assert/strict";
import { test } from "node:test";
import { answerWanted, oneAtATime, type Question } from "../src/dashboard/format.ts";

const q = (filters: string[], tools: boolean): Question => ({ filters, tools });

test("R93.1: an answer to a question the filter has since changed is dropped; the new one is kept", () => {
  const old = q(["actor=agent-1"], false);
  const now = q(["actor=agent-2"], false);
  assert.equal(answerWanted(old, now), false, "the old filter's answer is dropped");
  assert.equal(answerWanted(now, now), true, "the answer to the new question is kept");
  assert.equal(answerWanted(q(["actor=agent-1"], false), q([], false)), false, "a filter cleared");
  assert.equal(answerWanted(q([], false), q(["actor=agent-1"], false)), false, "a filter added");
});

test("R93.1: an answer asked with tool calls shown is dropped once they are unticked, and the other way round", () => {
  assert.equal(answerWanted(q([], true), q([], false)), false);
  assert.equal(answerWanted(q([], false), q([], true)), false);
  assert.equal(answerWanted(q(["type=review.*"], true), q(["type=review.*"], false)), false);
});

test("R93.1: the same filter texts in another order are another question", () => {
  assert.equal(answerWanted(q(["a=1", "b=2"], false), q(["b=2", "a=1"], false)), false);
  assert.equal(answerWanted(q(["a=1", "b=2"], false), q(["a=1", "b=2"], false)), true);
});

test("R93.1: a question is the same when it is an equal copy, not only the same object", () => {
  assert.equal(answerWanted(q(["actor=x"], true), q(["actor=x"], true)), true);
});

test("R93.2: two changes in a row: only the answer to the last is kept, in whatever order they come", () => {
  const first = q(["actor=a"], false);
  const second = q(["actor=b"], false);
  const last = q(["actor=b"], true);
  const now = last; // the page holds the last question when the answers come
  const asked = [first, second, last];
  const orders = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  for (const order of orders) {
    const kept = order.filter((i) => answerWanted(asked[i]!, now));
    assert.deepEqual(kept, [2], `order ${order.join(",")}: only the last is kept`);
  }
});

test("R93.2: a change back to an earlier question keeps an answer to that question", () => {
  const a = q(["actor=a"], false);
  const b = q(["actor=b"], false);
  // a, then b, then a again: the page holds a. The answer to b is dropped.
  assert.equal(answerWanted(b, a), false);
  assert.equal(answerWanted(a, a), true);
});

test("R93.3: with no change of the question, every answer is kept", () => {
  const questions = [
    q([], false),
    q([], true),
    q(["actor=agent-1"], false),
    q(["actor=agent-1", "type=review.*"], true),
    q(["", " "], false),
  ];
  for (const one of questions) {
    assert.equal(answerWanted(one, one), true);
    assert.equal(answerWanted(one, q([...one.filters], one.tools)), true);
  }
  // Several answers in a row to one standing question are all kept.
  const standing = q(["actor=agent-1"], false);
  const answers = [standing, q(["actor=agent-1"], false), q(["actor=agent-1"], false)];
  assert.equal(answers.filter((a) => answerWanted(a, standing)).length, 3);
});

test("R93.3: a poll still skips a round while one is on its way", async () => {
  let started = 0;
  let answer: (() => void) | undefined;
  const poll = oneAtATime(
    () =>
      new Promise<void>((resolve) => {
        started++;
        answer = resolve;
      }),
  );
  poll();
  poll();
  assert.equal(started, 1);
  answer!();
  await new Promise((r) => setImmediate(r));
  poll();
  assert.equal(started, 2);
});
