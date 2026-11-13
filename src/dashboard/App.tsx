// The dashboard page: the team right now and the event stream, read-only over howl serve.
import { useCallback, useEffect, useMemo, useState } from "react";
import { duration, type Handover, type KeyFigures } from "../read/overview.ts";
import type { AgentRow, AgentState } from "../read/state.ts";
import { since, worksOn } from "../read/state.ts";
import type { Item } from "../serve/server.ts";
import * as api from "./api.ts";
import { concerns, decodedFields, detail, filterPairs, standsOut, whenShort } from "./format.ts";
import { texts } from "./texts.ts";

const POLL_MS = 2000;
const LEDGER_POLL_MS = 10_000;

/** Calls `fn` now and every `ms` while `active`. */
function usePoll(fn: () => void, ms: number, active = true) {
  useEffect(() => {
    if (!active) return;
    fn();
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }, [fn, ms, active]);
}

type View = "overview" | "stream";
const viewOf = (hash: string): View => (hash === "#stream" ? "stream" : "overview");

export function App() {
  const [view, setView] = useState<View>(() => viewOf(location.hash));
  useEffect(() => {
    const changed = () => setView(viewOf(location.hash));
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((e: unknown) => setError((e as Error).message), []);

  const [agents, setAgents] = useState<api.Agents | null>(null);
  usePoll(
    useCallback(() => {
      api.agents().then((a) => (setAgents(a), setError(null)), fail);
    }, [fail]),
    POLL_MS,
    view === "stream",
  );

  const [ledger, setLedger] = useState<api.LedgerState | null>(null);
  usePoll(
    useCallback(() => {
      api.ledger().then(setLedger, fail);
    }, [fail]),
    LEDGER_POLL_MS,
  );

  return (
    <div className="min-h-screen">
      <Header view={view} />
      <main className="mx-auto flex max-w-[1360px] flex-col gap-5 px-4 py-6 sm:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[26px] font-semibold tracking-tight">{view === "overview" ? texts.overview.title : texts.title}</h1>
            <span className="text-[13px] text-mute">{view === "overview" ? texts.overview.subtitle : texts.subtitle}</span>
          </div>
          <div className="flex-1" />
          <LedgerBadge ledger={ledger} />
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-xl border border-line bg-error-pale px-4 py-3 text-error-ink">
            {texts.error(error)}
          </p>
        )}
        {view === "overview" ? (
          <Overview onError={fail} />
        ) : (
          <>
            <Team agents={agents} />
            <Stream onError={fail} />
          </>
        )}
      </main>
    </div>
  );
}

function Header({ view }: { view: View }) {
  const tab = (active: boolean) =>
    `rounded-lg px-3.5 py-2.5 no-underline ${active ? "bg-white/10 font-medium text-white" : "text-pale hover:text-white"}`;
  return (
    <header className="bg-ink text-white">
      <div className="mx-auto flex max-w-[1360px] flex-wrap items-center gap-x-7 gap-y-4 px-4 py-4 sm:px-8">
        <div className="flex items-center gap-3">
          <svg width="36" height="36" viewBox="0 0 64 64" aria-hidden="true">
            <defs>
              <clipPath id="logo-clip">
                <rect x="6" y="14" width="32" height="36" rx="9" />
              </clipPath>
            </defs>
            <rect x="26" y="14" width="32" height="36" rx="9" className="fill-accent-dark" clipPath="url(#logo-clip)" />
            <rect x="6" y="14" width="32" height="36" rx="9" fill="none" stroke="#fff" strokeWidth="5" />
            <rect x="26" y="14" width="32" height="36" rx="9" fill="none" className="stroke-accent-dark" strokeWidth="5" />
          </svg>
          <div className="flex flex-col gap-[3px] leading-none">
            <span className="text-lg font-semibold">{texts.brand}</span>
            <span className="font-mono text-[9px] tracking-[0.34em] text-accent-dark uppercase">{texts.brandSub}</span>
          </div>
        </div>
        <nav aria-label={texts.nav.label} className="flex flex-wrap gap-1">
          <a href="#overview" aria-current={view === "overview" ? "page" : undefined} className={tab(view === "overview")}>
            {texts.nav.overview}
          </a>
          <a href="#stream" aria-current={view === "stream" ? "page" : undefined} className={tab(view === "stream")}>
            {texts.nav.stream}
          </a>
        </nav>
      </div>
    </header>
  );
}

function LedgerBadge({ ledger }: { ledger: api.LedgerState | null }) {
  if (!ledger) return null;
  if (!ledger.ok) {
    return <div className="rounded-full bg-error-pale px-3.5 py-2.5 text-sm font-medium text-error-ink">{texts.broken(ledger.line)}</div>;
  }
  return (
    <div className="flex items-center gap-2 rounded-full bg-ok-pale px-3.5 py-2.5 text-sm font-medium text-ok-ink">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 12.5 L10 17.5 L19 7" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      {texts.verified(ledger.lines)}
      {ledger.trial && <span className="text-mute">· {texts.trial}</span>}
    </div>
  );
}

function Overview({ onError }: { onError: (e: unknown) => void }) {
  const [data, setData] = useState<{ figures: KeyFigures; handovers: Handover[] } | null>(null);
  usePoll(
    useCallback(() => {
      api.overview().then(setData, onError);
    }, [onError]),
    LEDGER_POLL_MS,
  );
  const f = data?.figures;
  const tiles = f
    ? [
        { label: texts.overview.open, value: String(f.open), note: texts.overview.openNote },
        { label: texts.overview.lead, value: f.leadTimeMedianMs === null ? texts.overview.none : duration(f.leadTimeMedianMs), note: texts.overview.leadNote(f.periodDays) },
        {
          label: texts.overview.rounds,
          value: f.reviewRoundsMean === null ? texts.overview.none : f.reviewRoundsMean.toFixed(1),
          note: texts.overview.roundsNote(f.periodDays, f.merged),
        },
      ]
    : [];
  const th = "px-3 py-2.5 font-medium";
  return (
    <>
      <section aria-label={texts.overview.figures} className="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-4">
        {tiles.map((t) => (
          <div key={t.label} className="flex flex-col gap-1.5 rounded-xl border border-line bg-white px-5 py-[18px]">
            <span className="text-[13px] text-mute">{t.label}</span>
            <span className="text-3xl font-semibold tracking-tight">{t.value}</span>
            <span className="text-[13px] text-mute">{t.note}</span>
          </div>
        ))}
      </section>
      <section aria-labelledby="ho-h" className="flex flex-col gap-3.5 rounded-xl border border-line bg-white px-6 py-[22px]">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h2 id="ho-h" className="m-0 text-lg font-semibold">
            {texts.overview.heading}
          </h2>
          <span className="text-[13px] text-mute">{texts.overview.note}</span>
          <div className="flex-1" />
          <a href="#stream" className="py-2.5 text-sm font-medium text-ink">
            {texts.overview.toStream}
          </a>
        </div>
        {data && data.handovers.length === 0 ? (
          <p className="m-0 text-mute">{texts.overview.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs tracking-wider text-mute uppercase">
                  <th scope="col" className={`${th} pl-0`}>{texts.overview.cols.time}</th>
                  <th scope="col" className={th}>{texts.overview.cols.change}</th>
                  <th scope="col" className={th}>{texts.overview.cols.fromTo}</th>
                  <th scope="col" className={th}>{texts.overview.cols.step}</th>
                  <th scope="col" className={th}>{texts.overview.cols.model}</th>
                  <th scope="col" className={`${th} pr-0`}>{texts.overview.cols.hash}</th>
                </tr>
              </thead>
              <tbody>
                {(data?.handovers ?? []).map((h) => (
                  <tr key={`${h.time}-${h.change}-${h.step}-${h.from}`} className="border-t border-line">
                    <td className="py-3 pr-3 font-mono text-[13px] whitespace-nowrap">{whenShort(h.time, Date.now())}</td>
                    <td className="p-3">
                      <div className="font-medium">{texts.overview.change(h.change)}</div>
                      {h.task !== undefined && <div className="text-[13px] text-mute">{texts.overview.task(h.task)}</div>}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      {h.from} → {h.to === "merged" ? texts.overview.merged : h.to}
                    </td>
                    <td className="p-3">{h.step}</td>
                    <td className="p-3 font-mono text-[13px]">{[h.model, h.effort].filter(Boolean).join(" · ") || "–"}</td>
                    <td className="py-3 pl-3 font-mono text-[13px] text-mute" title={h.hash}>
                      {h.hash ? `${h.hash.slice(0, 4)}…${h.hash.slice(-4)}` : "–"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

const STATE_STYLE: Record<AgentState, { pill: string; dot: string }> = {
  working: { pill: "bg-ok-pale text-ok-ink", dot: "bg-ok" },
  waiting: { pill: "bg-warn-pale text-warn-ink", dot: "bg-accent" },
  idle: { pill: "bg-faint text-mute", dot: "bg-gray-400" },
  ended: { pill: "bg-faint text-mute", dot: "bg-ink" },
};

function Team({ agents }: { agents: api.Agents | null }) {
  const rows = agents?.rows ?? [];
  const waiting = rows.filter((r) => r.state === "waiting").length;
  const th = "px-3 py-2 font-medium";
  return (
    <section aria-labelledby="team-h" className="flex flex-col gap-1 rounded-xl border border-line bg-white px-6 py-5">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-2">
        <h2 id="team-h" className="m-0 text-lg font-semibold">
          {texts.team.heading}
        </h2>
        <span className="text-[13px] text-mute">{texts.team.note(waiting)}</span>
      </div>
      {agents && rows.length === 0 ? (
        <p className="m-0 text-mute">{texts.team.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wider text-mute uppercase">
                <th scope="col" className={`${th} pl-0`}>{texts.team.cols.agent}</th>
                <th scope="col" className={th}>{texts.team.cols.state}</th>
                <th scope="col" className={th}>{texts.team.cols.worksOn}</th>
                <th scope="col" className={th}>{texts.team.cols.model}</th>
                <th scope="col" className={th}>{texts.team.cols.tool}</th>
                <th scope="col" className={`${th} pr-0 text-right`}>{texts.team.cols.since}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <AgentLine key={r.agent} row={r} now={agents!.now} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function AgentLine({ row, now }: { row: AgentRow; now: number }) {
  const style = STATE_STYLE[row.state];
  return (
    <tr className="border-t border-faint">
      <td className="py-3 pr-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 flex-none items-center justify-center rounded-[10px] border-[1.5px] border-accent bg-accent-pale font-semibold text-accent">
            {row.agent[0]?.toUpperCase()}
          </div>
          <span className="font-semibold">{row.agent}</span>
        </div>
      </td>
      <td className="p-3">
        <span className={`inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-[13px] font-medium ${style.pill}`}>
          <span className={`h-2 w-2 rounded-full ${style.dot}`} />
          {texts.team.states[row.state]}
        </span>
      </td>
      <td className="p-3">
        <div className="font-medium">{worksOn(row) || row.branch || "–"}</div>
        {worksOn(row) && row.branch && <div className="text-[13px] text-mute">{row.branch}</div>}
      </td>
      <td className="p-3 font-mono text-[13px]">{[row.model, row.effort].filter(Boolean).join(" · ") || "–"}</td>
      <td className="p-3 font-mono text-[13px]">{[row.tool, row.target].filter(Boolean).join(" ") || "–"}</td>
      <td className="py-3 pl-3 text-right font-mono text-[13px] whitespace-nowrap">{since(row.last, now)}</td>
    </tr>
  );
}

const ROW_TINT = { warn: "bg-warn-pale", error: "bg-error-pale" };

function keyOf(item: Item): string {
  return item.event.id;
}

function Stream({ onError }: { onError: (e: unknown) => void }) {
  const [paused, setPaused] = useState(false);
  const [tools, setTools] = useState(false);
  const [draft, setDraft] = useState("");
  const [filters, setFilters] = useState<string[]>([]);
  const [filterError, setFilterError] = useState<string | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(() => {
    api.events(filters, tools).then(
      (r) => {
        setItems([...r.events].reverse());
        setFilterError(null);
      },
      (e: Error) => (filters.length > 0 ? setFilterError(e.message) : onError(e)),
    );
  }, [filters, tools, onError]);
  usePoll(load, POLL_MS, !paused);

  const selected = useMemo(() => items.find((i) => keyOf(i) === picked) ?? items[0] ?? null, [items, picked]);
  const button = "min-h-11 cursor-pointer rounded-lg px-4 text-sm font-medium";
  const th = "px-3 py-2.5 font-medium";

  return (
    <>
      <section aria-labelledby="stream-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <h2 id="stream-h" className="m-0 text-lg font-semibold">
            {texts.stream.heading}
          </h2>
          {paused ? (
            <span className="rounded-full bg-line px-3 py-2 text-sm font-medium text-gray-700">{texts.stream.paused}</span>
          ) : (
            <span className="flex items-center gap-2 rounded-full bg-ok-pale px-3 py-2 text-sm font-medium text-ok-ink">
              <span className="h-2 w-2 rounded-full bg-ok" />
              {texts.stream.live}
            </span>
          )}
          <button type="button" onClick={() => setPaused(!paused)} className={`${button} border border-pale bg-white text-ink`}>
            {paused ? texts.stream.resume : texts.stream.pause}
          </button>
          <div className="flex-1" />
          <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
            <input type="checkbox" checked={tools} onChange={(e) => setTools(e.target.checked)} className="m-0 h-5 w-5 accent-ink" />
            {texts.stream.showTools}
          </label>
        </div>

        <form
          className="flex flex-wrap items-end gap-2.5 rounded-xl border border-line bg-white px-4 py-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(filterPairs(draft));
          }}
        >
          <label className="flex flex-[1_1_420px] flex-col gap-1 text-[13px] text-mute">
            {texts.stream.filterLabel}
            <input
              type="text"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="actor=agent-1 type=session.*"
              spellCheck={false}
              aria-invalid={filterError !== null}
              className={`min-h-11 rounded-lg border-[1.5px] bg-white px-3 font-mono text-sm text-ink ${filterError ? "border-error-ink" : "border-pale"}`}
            />
          </label>
          <button type="submit" className={`${button} border-0 bg-ink text-white`}>
            {texts.stream.apply}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft("");
              setFilters([]);
            }}
            className={`${button} border border-pale bg-white text-ink`}
          >
            {texts.stream.clear}
          </button>
          <span className={`basis-full text-[13px] ${filterError ? "text-error-ink" : "text-mute"}`} role={filterError ? "alert" : undefined}>
            {filterError ?? texts.stream.filterHint}
          </span>
        </form>

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="max-h-[560px] overflow-auto" tabIndex={0} aria-label={texts.stream.heading}>
            <table className="w-full min-w-[960px] border-collapse font-mono text-[13px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-[#f7f8fa] text-left font-sans text-xs tracking-wider text-mute uppercase">
                  <th scope="col" className={th}>{texts.stream.cols.line}</th>
                  <th scope="col" className={th}>{texts.stream.cols.time}</th>
                  <th scope="col" className={th}>{texts.stream.cols.actor}</th>
                  <th scope="col" className={th}>{texts.stream.cols.type}</th>
                  <th scope="col" className={th}>{texts.stream.cols.concerns}</th>
                  <th scope="col" className={th}>{texts.stream.cols.source}</th>
                  <th scope="col" className={th}>{texts.stream.cols.detail}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isPicked = selected !== null && keyOf(item) === keyOf(selected);
                  const tint = standsOut(item);
                  const bg = isPicked ? "bg-picked font-medium outline-[1.5px] -outline-offset-[1.5px] outline-ink outline" : tint ? ROW_TINT[tint] : item.from === "activity" ? "bg-[#fafbfc] text-mute" : "bg-white";
                  const label = item.from === "ledger" ? String(item.n) : "·";
                  return (
                    <tr key={keyOf(item)} className={`border-t border-line ${bg}`}>
                      <td className="p-0">
                        <button
                          type="button"
                          onClick={() => setPicked(keyOf(item))}
                          aria-label={texts.stream.showEvent(item.from === "ledger" ? label : item.event.type)}
                          aria-pressed={isPicked}
                          className="min-h-10 w-full cursor-pointer border-0 bg-transparent px-3 text-left font-[inherit] text-inherit"
                        >
                          {label}
                        </button>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{whenShort(item.event.time, Date.now())}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{item.event.actor?.id ?? "–"}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{item.event.type}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{concerns(item)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-mute">{item.event.source.kind}</td>
                      <td className="px-3 py-2 font-sans">{detail(item)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-4 py-2.5 text-[13px] text-mute">
            {items.length === 0 ? texts.stream.empty : texts.stream.count(items.length, tools)}
          </div>
        </div>
      </section>

      <div className="flex flex-wrap gap-4">
        <section aria-label={texts.decoded.sub} className="flex min-w-0 flex-[1_1_420px] flex-col gap-2.5 rounded-xl border border-line bg-white px-5 py-[18px]">
          {selected ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
                <h2 className="m-0 text-base font-semibold">{selected.from === "ledger" ? texts.decoded.line(selected.n ?? 0) : texts.decoded.tool}</h2>
                <span className="text-[13px] text-mute">{texts.decoded.sub}</span>
              </div>
              <dl className="m-0 grid grid-cols-[minmax(120px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                {decodedFields(selected).map((f) => (
                  <div key={f.k} className="contents">
                    <dt className="text-mute">{f.k}</dt>
                    <dd className="m-0 font-mono [overflow-wrap:anywhere]">{f.v}</dd>
                  </div>
                ))}
              </dl>
            </>
          ) : (
            <p className="m-0 text-mute">{texts.decoded.none}</p>
          )}
        </section>
        <section aria-labelledby="raw-h" className="flex min-w-0 flex-[1_1_420px] flex-col gap-2.5 rounded-xl bg-ink px-5 py-[18px] text-gray-200">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <h2 id="raw-h" className="m-0 text-base font-semibold text-white">
              {texts.raw.heading}
            </h2>
            <span className="text-[13px] text-pale">{texts.raw.sub}</span>
          </div>
          <pre className="m-0 max-h-[420px] overflow-auto font-mono text-xs leading-relaxed">
            {selected ? JSON.stringify(JSON.parse(selected.raw), null, 2) : ""}
          </pre>
        </section>
      </div>
    </>
  );
}
