// The change view of the dashboard: one change or task, its whole timeline, as `howl show` gives it in the terminal (#22).
// @code_class reading
import { useEffect, useRef, useState } from "react";
import { duration } from "../read/words.ts";
import { roundText } from "../read/rounds.ts";
import type { Shown } from "../read/show.ts";
import type { Item } from "../serve/server.ts";
import * as api from "./api.ts";
import { EventDialog } from "./EventDialog.tsx";
import { eventFilter, flowOf, rowName, type Flow, type Row } from "./flow.ts";
import { claimText, hashFor, headText, otherChangeLinks, traceText, sessionText, summarySpans, waitSpan, whenShort } from "./format.ts";
import { texts } from "./texts.ts";

const t = texts.change;

/** `Task 12`, or for a change that was asked for `Change 65 of task 40`, or `Change 65` where no task is known. */
function title(shown: Shown): string {
  const change = shown.changes[0]?.change ?? "";
  if (shown.asked === "task" && shown.task !== undefined) return t.task(shown.task);
  return shown.task !== undefined ? t.changeOfTask(change, shown.task) : t.changeTitle(change);
}

/** One lane's column, in rem: the arrows are laid out in these, so a line runs from the middle of one to the middle of another. */
const LANE_REM = 9;
const TIME_REM = 5;

/**
 * #192: the change as a flow graph, in HTML and CSS: a lane for each team member, the code host and the checks, time
 * running down, one row for each arrow or note. An arrow or a note is a button that opens its event. The graph is no
 * live region: the view is read once, not polled. What follows a click is told once: a call that failed as an alert (as
 * #191 sets a load error), an event that is not in the ledger now as a status. A line is solid for an observed event and
 * dashed for a claimed one, and each row says which in words as well.
 */
function FlowGraph({ flow, now, onOpen, note }: { flow: Flow; now: number; onOpen: (row: Row) => void; note: { text: string; failed: boolean } | null }) {
  const g = texts.flow;
  const index = (key: string) => flow.lanes.findIndex((l) => l.key === key);
  const template = { gridTemplateColumns: `${TIME_REM}rem repeat(${flow.lanes.length}, ${LANE_REM}rem)` };
  const width = { minWidth: `${TIME_REM + flow.lanes.length * LANE_REM}rem` };
  const border = { solid: "border-solid", dashed: "border-dashed", dotted: "border-dotted" } as const;
  return (
    <>
      <p className="m-0 text-[13px] text-mute">{g.note}</p>
      {flow.rows.length === 0 ? (
        <p className="m-0 text-mute">{g.empty}</p>
      ) : (
        <div role="region" aria-label={g.scroll} tabIndex={0} className="overflow-x-auto rounded-lg border border-line">
          <div style={width}>
            <div className="grid border-b border-line bg-[#f7f8fa]" style={template}>
              <span className="sticky left-0 bg-[#f7f8fa] px-2 py-2 text-[11px] text-mute">{g.timeColumn}</span>
              {flow.lanes.map((l) => (
                <span key={l.key} className="flex flex-col items-center px-1 py-2 text-center text-[13px] font-semibold [overflow-wrap:anywhere]">
                  {l.label}
                  <span className="text-[11px] font-normal text-mute">{g.laneKinds[l.kind]}</span>
                </span>
              ))}
            </div>
            <ol className="m-0 flex list-none flex-col p-0">
              {flow.rows.map((row, i) => {
                const a = index(row.from);
                const b = index(row.to);
                const within = a === b;
                const first = Math.min(a, b) + 2;
                const last = Math.max(a, b) + 2;
                const when = whenShort(row.time, now);
                const rightwards = b > a;
                return (
                  <li key={`${row.event.id}:${i}`} className="grid items-center border-b border-faint" style={template}>
                    <span aria-hidden="true" className="sticky left-0 z-10 bg-white px-2 font-mono text-[12px] text-mute">
                      {when}
                    </span>
                    {flow.lanes.map((l, j) => (
                      <span key={l.key} aria-hidden="true" style={{ gridColumn: j + 2, gridRow: 1 }} className="relative min-h-[3.75rem] before:absolute before:inset-y-0 before:left-1/2 before:w-px before:bg-pale" />
                    ))}
                    <button
                      type="button"
                      data-flow={row.event.id}
                      aria-label={rowName(row, flow.lanes, when)}
                      title={g.opens}
                      onClick={() => onOpen(row)}
                      style={within ? { gridColumn: first, gridRow: 1 } : { gridColumn: `${first} / ${last + 1}`, gridRow: 1, marginInline: `${LANE_REM / 2}rem` }}
                      className={`relative z-[1] flex min-h-11 cursor-pointer flex-col items-stretch justify-center gap-0.5 rounded border-0 bg-transparent p-0 font-sans text-ink ${row.kind === "note" ? `mx-auto w-[calc(100%-1rem)] rounded-lg border-2 ${border[row.line]} border-pale bg-warn-pale px-2 py-1` : ""} ${within && row.kind === "arrow" ? `mx-auto w-[calc(100%-1rem)] rounded-lg border-2 ${border[row.line]} border-ink bg-white px-2 py-1` : ""} ${row.origin === "claimed" && !within ? "italic" : ""}`}
                    >
                      <span className="flex flex-col items-center text-center text-[12px] leading-tight">
                        <span className={`${row.kind === "arrow" && !within ? "bg-white px-1" : ""} ${row.kind === "note" ? "font-medium text-warn-ink" : ""}`}>
                          {row.kind === "note" && <span aria-hidden="true">◷ </span>}
                          {row.label}
                        </span>
                        <span className="text-[11px] text-mute">
                          {g.origin[row.origin]}
                          {row.matched !== undefined && ` · ${g.matched(row.matched)}`}
                        </span>
                      </span>
                      {row.kind === "arrow" && !within && (
                        <span aria-hidden="true" className="flex items-center text-ink">
                          {!rightwards && <span className="-mr-0.5 text-[10px] leading-none">◀</span>}
                          <span className={`flex-1 border-t-2 ${border[row.line]} border-ink`} />
                          {rightwards && <span className="-ml-0.5 text-[10px] leading-none">▶</span>}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ol>
          </div>
        </div>
      )}
      {note !== null && (
        <p role={note.failed ? "alert" : "status"} className="m-0 text-[13px] text-warn-ink">
          {note.text}
        </p>
      )}
    </>
  );
}

export function ChangeView({ what, project, onError }: { what: string | null; project: string; onError: (e: unknown) => void }) {
  const [draft, setDraft] = useState(what ?? "");
  const [shown, setShown] = useState<Shown | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  // #192: the event an arrow or a note opened, and what to say when it is not in the ledger now.
  const [picked, setPicked] = useState<Item | null>(null);
  const [flowNote, setFlowNote] = useState<{ text: string; failed: boolean } | null>(null);
  const opener = useRef<string | null>(null);
  // The call for an event that is the latest: an answer to an older one, or to another change, is dropped.
  const asked = useRef(0);

  useEffect(() => {
    setDraft(what ?? "");
    setShown(null);
    setMissing(null);
    setPicked(null);
    setFlowNote(null);
    asked.current++;
    if (!what) return;
    api.show(what).then(
      (s) => (s === null ? setMissing(what) : setShown(s)),
      (e) => onError(e),
    );
  }, [what, project, onError]);

  const flow = shown === null ? null : flowOf(shown);
  // The graph's event has no line number in what `show` gives: the page asks for it by its id, as the band does for a wait.
  const open = (row: Row) => {
    const mine = ++asked.current;
    api.events([eventFilter(row.event.id)], false, 5).then(
      (r) => {
        if (asked.current !== mine) return;
        const found = r.events.find((i) => i.event.id === row.event.id && (i.project === undefined || i.project === project));
        if (found === undefined) return setFlowNote({ text: texts.flow.notFound, failed: false });
        opener.current = row.event.id;
        setFlowNote(null);
        setPicked(found);
      },
      (e: Error) => asked.current === mine && setFlowNote({ text: e.message, failed: true }),
    );
  };

  const card = "flex flex-col gap-2 rounded-xl border border-line bg-white px-6 py-5";
  const row = "flex flex-wrap gap-x-3 font-mono text-[13px]";
  const now = Date.now();

  return (
    <>
      <form
        className="flex flex-wrap items-end gap-2.5 rounded-xl border border-line bg-white px-4 py-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          location.hash = hashFor("change", project, draft.trim() || null);
        }}
      >
        <label className="flex flex-[1_1_320px] flex-col gap-1 text-[13px] text-mute">
          {t.label}
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="30, change:30 or task:12"
            spellCheck={false}
            className="min-h-11 rounded-lg border-[1.5px] border-pale bg-white px-3 font-mono text-sm text-ink"
          />
        </label>
        <button type="submit" className="min-h-11 cursor-pointer rounded-lg border-0 bg-ink px-4 text-sm font-medium text-white">
          {t.open}
        </button>
      </form>

      {missing && (
        <p role="status" className="m-0 text-mute">
          {t.none(missing)}
        </p>
      )}

      {shown && (
        <>
          <section aria-labelledby="ch-title" className={card}>
            <h2 id="ch-title" className="m-0 text-lg font-semibold">
              {title(shown)} · {t.end[shown.end.state]}
            </h2>
            {shown.task !== undefined && shown.otherChanges.length > 0 && (
              <p className="m-0 text-[13px]">
                {(() => {
                  const line = otherChangeLinks(shown.task, shown.otherChanges, project);
                  return (
                    <>
                      <a href={line.task.href}>{line.task.label}</a>
                      {t.otherChanges(line.changes.length)}
                      {line.changes.map((c, i) => (
                        <span key={c.label}>
                          {i > 0 && ", "}
                          <a href={c.href}>{c.label}</a>
                        </span>
                      ))}
                    </>
                  );
                })()}
              </p>
            )}
          </section>

          {flow !== null && (
            <section aria-labelledby="ch-flow" className={card}>
              <h2 id="ch-flow" className="m-0 text-base font-semibold">
                {texts.flow.heading}
              </h2>
              <FlowGraph flow={flow} now={now} onOpen={open} note={flowNote} />
            </section>
          )}

          <section aria-label={t.summaryLabel} className={card}>
            <p className="m-0 text-[13px] text-mute">
              {((spans) =>
                t.summary(
                  duration(spans.all),
                  duration(spans.work),
                  duration(spans.checks),
                  duration(spans.review),
                  duration(spans.waits),
                  duration(spans.unknown),
                  shown.summary.reviewRounds,
                ))(summarySpans(shown.summary))}
            </p>
          </section>

          <section aria-labelledby="ch-sessions" className={card}>
            <h2 id="ch-sessions" className="m-0 text-base font-semibold">
              {t.sessions}
            </h2>
            {shown.sessions.length === 0 && <p className="m-0 text-mute">{t.noSessions}</p>}
            {shown.sessions.map((s) => (
              <div key={s.session} className="flex flex-col gap-1 border-t border-faint pt-2">
                <div className={row}>
                  <span className="text-mute">{whenShort(s.start, now)}</span>
                  <span className="font-sans font-medium">{sessionText(s)}</span>
                </div>
                {s.waits.map((w) => (
                  <div key={w.time} className={`${row} pl-4 text-mute`}>
                    {whenShort(w.time, now)} · {t.wait(w.kind, ((ms) => (ms === null ? t.stillWaiting : duration(ms)))(waitSpan(w.seconds)))}
                  </div>
                ))}
              </div>
            ))}
          </section>

          {shown.changes.map((c) => (
            <section key={c.change} aria-label={t.changeTitle(c.change)} className={card}>
              <h2 className="m-0 text-base font-semibold">
                {t.changeTitle(c.change)} <span className="font-mono text-[13px] font-normal text-mute">{c.branch}</span>
              </h2>
              {c.opened && (
                <div className={row}>
                  <span className="text-mute">{whenShort(c.opened.time, now)}</span>
                  {t.opened(c.opened.by ? `${c.opened.by} ${texts.via(c.opened.actor?.id ?? "")}` : (c.opened.actor?.id ?? "–"))}
                </div>
              )}
              {c.heads.map((h, i) => (
                <div key={`${i}:${h.sha}`} className={`${row} ${h.checks === "failed" ? "text-error-ink" : ""}`}>
                  <span className="text-mute">{whenShort(h.time, now)}</span>
                  {headText(h, i === 0)}
                  <span className="text-mute"> · {traceText(h.trace)}</span>
                </div>
              ))}
              {c.comments > 0 && <div className={`${row} text-mute`}>{t.comments(c.comments)}</div>}
              {shown.changes.length > 1 && (
                <div className={row}>
                  <span className="text-mute">{c.end.state === "open" ? "" : whenShort(c.end.time, now)}</span>
                  {t.end[c.end.state]}
                </div>
              )}
            </section>
          ))}

          <section aria-labelledby="ch-reviews" className={card}>
            <h2 id="ch-reviews" className="m-0 text-base font-semibold">
              {t.reviews}
            </h2>
            {shown.reviews.length === 0 && <p className="m-0 text-mute">{t.noReviews}</p>}
            {shown.reviews.map((r, i) => {
              // #117: where the view has more than one change, a round says which change it is of.
              const number = shown.reviews.slice(0, i + 1).filter((x) => x.change === r.change).length;
              return (
                <div key={i} className={row}>
                  <span className="font-sans font-medium">{shown.changes.length > 1 && r.change !== undefined ? t.roundOf(number, r.change) : t.round(number)}</span>
                  {roundText(r.reviews)}
                </div>
              );
            })}
          </section>

          {shown.claimed.length > 0 && (
            <section aria-labelledby="ch-claimed" className={card}>
              <h2 id="ch-claimed" className="m-0 text-base font-semibold">
                {t.claimed}
              </h2>
              <p className="m-0 text-[13px] text-mute">{t.claimedNote}</p>
              {shown.claimed.map((c, i) => (
                <div key={i} className={row}>
                  <span className="text-mute">{whenShort(c.time, now)}</span>
                  {claimText(c)}
                </div>
              ))}
            </section>
          )}
        </>
      )}

      {picked !== null && (
        <EventDialog
          item={picked}
          onPick={setPicked}
          onClose={() => {
            const id = opener.current;
            setPicked(null);
            // Back to the arrow or note that opened it.
            requestAnimationFrame(() => {
              for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-flow]")) if (b.dataset.flow === id) return b.focus();
            });
          }}
        />
      )}
    </>
  );
}
