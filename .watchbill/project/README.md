# The project's own text

These files are the project's own. They are not part of the revision, they are not in its
manifest, and `wb check` does not fail on them. They may be changed at any time.

- `all.md` is added to the prompt of every role.
- `<role>.md` is added to the prompt of that role only: `build.md`, `review.md`, `fix.md`, `tester.md`.

Both are optional. Write in them how things are done here: the commands, the board, the words.

A prompt is the role's text of the revision, then one line saying that this text follows, then
`all.md`, then `<role>.md`. The text here adds to a role. It never lifts a limit of a role: what
the role must not do stays so, whatever is written here.

A placeholder is a lower-case word in braces: `{`, a letter a to z, letters a to z or `_`, then `}`,
with no `$` just before it. `{task}`, `{change}`, `{requirements}` and `{round}` are known and are
filled in; any other placeholder is refused. Anything else in braces is text: `${BUILD_DIR}`,
`{Task}`, `{task-id}` and `{ task }` stay as they are. A review of a change to `.watchbill/` reads that this text does not
speak against the role.
