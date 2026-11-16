// The change view of the dashboard: one change or task, its whole timeline, as `howl show` gives it in the terminal (#22).
// @code_class reading
import { useEffect, useState } from "react";
import { duration } from "../read/overview.ts";
import { roundText } from "../read/rounds.ts";
import type { Shown } from "../read/show.ts";
import * as api from "./api.ts";
import { claimText, hashFor, headText, otherChangeLinks, traceText, sessionText, whenShort } from "./format.ts";
import { texts } from "./texts.ts";

const t = texts.change;

/** `Task 12`, or for a change that was asked for `Change 65 of task 40`, or `Change 65` where no task is known. */
function title(shown: Shown): string {
  const change = shown.changes[0]?.change ?? "";
  if (shown.asked === "task" && shown.task !== undefined) return t.task(shown.task);
  return shown.task !== undefined ? t.changeOfTask(change, shown.task) : t.changeTitle(change);
}

export function ChangeView({ what, project, onError }: { what: string | null; project: string; onError: (e: unknown) => void }) {
  const [draft, setDraft] = useState(what ?? "");
  const [shown, setShown] = useState<Shown | null>(null);
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    setDraft(what ?? "");
    setShown(null);
    setMissing(null);
    if (!what) return;
    api.show(what).then(
      (s) => (s === null ? setMissing(what) : setShown(s)),
      (e) => onError(e),
    );
  }, [what, project, onError]);

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
            <p className="m-0 text-[13px] text-mute">
              {t.summary(
                duration(shown.summary.seconds * 1000),
                duration(shown.summary.parts.work * 1000),
                duration(shown.summary.parts.checks * 1000),
                duration(shown.summary.parts.review * 1000),
                duration((shown.summary.parts.person + shown.summary.parts.instructions) * 1000),
                duration(shown.summary.parts.unknown * 1000),
                shown.summary.reviewRounds,
              )}
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
                    {whenShort(w.time, now)} · {t.wait(w.kind, w.seconds === null ? t.stillWaiting : duration(w.seconds * 1000))}
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
    </>
  );
}
