# Observation mode

The first thing to build and to try: `howl` beside a team whose agents already work, recording what they do and steering nothing.

## What it is

The levels ([levels.md](levels.md)) say how much the agents may do. Observation mode says what `howl` does: it only records. The two are independent. A team can let its agents do nearly everything and still run `howl` in observation mode, to see what the agents do during an assignment. That is what no code host shows.

It is also the cheapest way to try the platform: nothing in the team's flow changes.

## Two sources of events

| Source | Shows | How |
|---|---|---|
| Hooks of the coding agent (Claude Code first) | Session start, every tool call, waiting for a person, the end, per agent | `howl hook`, called from the agent's settings |
| The code host | Task given to a team member, change opened, checks, review, rounds, merge | `howl observe` reads the repository every minute |

The hooks are needed for a second reason. Where the agents act through one person's account, the code host cannot tell one agent from another. The hook knows which agent it runs for.

An event from a hook is a claim by the agent's own session; an event read from the code host is observed. Each event is marked with which it is ([traceability.md](traceability.md)).

## The steps

1. **The schema and the ledger.** The event schema as JSON Schema, a ledger file with a hash chain kept outside the repository, and `howl verify`. An event does not know its place: the hash of the line before belongs to the line, not to the event.
2. **`howl hook`.** Reads the hook's JSON and puts an event in an inbox. Several sessions write at once, so only one process brings the events into the chain. `howl emit` lets a script do the same.
3. **`howl observe`.** The reader of the code host. It also empties the inbox.
4. **`howl watch` and `howl show <task>`.** The stream in the terminal, and the timeline of one assignment from the hand-over to the merge. `howl watch` shows the handovers of the ledger; `--activity` adds the tool calls. Both print local time; `--utc` prints the times as stored.

Steps 1 and 2 already show the agents' work as it happens. The dashboard and the editor extension wait.

## What the observed repository needs

Two things, and nothing else:

- a `.howl/howl.yml` that names the project,
- the hook lines in the agent's settings.

Only the sessions of agents are recorded. A person's session leaves nothing: people are not measured one by one.

```yaml
# .howl/howl.yml
project: example
```

## Rules for this mode

- **Do not record all content.** A tool call can hold keys and code. Keep the tool, the target and the outcome, and a hash of the input, not the whole command and its answer. A large organisation will demand the same. With `howl hook` the rest is dropped in the hook's own process. With the hook line that is only `curl`, the hook's JSON reaches `howl up` on the same machine, which keeps the event it builds and never writes, logs or sends back the rest. Before a server runs on another machine, it is decided again where the content is dropped.
- **This is a trial.** Where the agents run as the same user that keeps the ledger, it serves observation but is not evidence. The ledger says so in its first line.
- **Evidence and activity are kept apart.** The chain holds the handovers: a session's start and end, a wait for a person, and what the code host shows. Tool calls are activity: many, kept in a file of their own without a chain, and removed after a time.
- **People are not measured one by one.** A person is named by a pseudonym, kept beside the ledger and never in it. No figure is given per person.
- **One writer.** Hooks and scripts never write to the chain. They leave one file per event in an inbox, and one process brings them in. When that process runs as `howl up`, the hook hands the event to it over HTTP on the same machine, and the writer leaves it in the inbox itself; the file is the way when the writer cannot be reached.
- **A hook never disturbs the session.** It is quick, prints nothing and always ends without an error, also when the ledger cannot be reached.
- **No repository, no event.** Without a `.howl/` folder above the working directory the hook does nothing.

## Scripts

What a team programs itself is Python or a shell script ([architecture.md](architecture.md)). `howl emit` writes an event from a script without building the JSON by hand:

```sh
howl emit checks.passed --change 123 --data '{"check":"static-analysis"}'
```
