# How things are done in Handover Ledger

## Where the work is

- The repository is `fa1k3n/handover-ledger` on GitHub. Work in the checkout you were started in. Do not clone it again.
- Read the issue with `gh issue view {issue}` and its comments with `gh issue view {issue} --comments`. The issue is the spec. When its file `.watchbill/issues/{issue}.yml` is accepted, the requirements are the points of that file (`{issue}.1`, `{issue}.2`, …) and your prompt holds them. Otherwise they are the numbered items in the issue. This project has no table of requirements.
- A change is a pull request, from the branch `{branch}`, made from `main` before the breakdown starts. The breakdown commits the issue's file on it first, alone. The tester, the build and the fix commit on that branch. They do not push: a person pushes.
- A person opens the pull request as a draft, with "Closes #{issue}" in its description. The build writes that description in the message of its last commit, and `wb` says the command that opens it. No session opens one.
- Read a pull request with `gh pr view <number>`, its comments with `gh pr view <number> --comments`, and its diff with `gh pr diff <number>`. Post on it with `gh pr comment <number> --body-file <file>`.
- The review posts its findings as one comment whose first line starts with `[review] round <n>`. The fix posts its answers as one comment whose first line starts with `[fix] round <n>`.
- Never mark a pull request ready, never merge, and never run `scripts/ruleset.sh`.

## Reading

- A search reads every file it searches: `grep`, `rg`, `find` with content, or any tool that reads files to answer. Keep each search to the files you may read. Searching a folder opens every file in it.
- A helper that a test uses, in a file you were not given, is outside what you may read. Stop and ask for it. Do not open it.
- When a file you may read holds both the interface and the body of the thing under test, read only the interface, and say in your last message which file it was.

## Checks

- You work in a view: only the files your list gives you are there. `npm run check` needs the whole tree, so you do not run it. The check on the pull request (`.github/workflows/check.yml`) runs it, and the review starts only when it is green.
- First run `npm ci`. `package.json` and `package-lock.json` are in your list for this.
- Run each test file you may read with `node --test <file>`.
- The tester runs its own test files once they are committed. Under `checks` it reports anything that fails for a reason other than the code that is not there yet.
- The build and the fix run the test files of the issue before they end, and say under `checks` which ran.
- The breakdown lists `package.json` and `package-lock.json` in the reads of the tester, the build, the review and the fix, and every file a listed test imports.
- Never run `npm run gen` to make a check pass. The types are generated from `schema/`, and a change to them belongs to the task.

## Tests

- Tests use `node:test` and no framework. A test's name starts with the requirement it covers: `R` and the requirement's ID: `R{issue}.1: …`.
- A test for a clause that already holds before the change is a guard. Write it, run it, see it pass, and list it as a guard in your last message. It cannot be red, and it is not a fault that it is not.
- Test data that must match byte for byte goes in `test/fixtures/`, not in the test.

## Code classes

- `.howl/howl.yml` sorts the paths into classes: `evidence`, `rules`, `recording`, `reading`, `tests` and `documents`. A file says its class in a header `@code_class <name>`.
- A change that touches `evidence`, `rules` or `recording` is classed. Its review says so on the first line of its findings, and a person verifies it. A review never stands in for that person.

## Words

- Plain, short sentences, in British spelling.
- Say "audit-ready" or "supports certification", never "certified".
- No client's names, rules or data, anywhere.

## How you end

Your last message has every field your role lists, every time, also when you stop early. A message without them is not taken, and you will be asked again.
