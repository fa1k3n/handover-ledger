// The dashboard page: the team right now and the event stream, read-only over howl serve.
// @code_class reading
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Handover, KeyFigures } from "../read/overview.ts";
import type { AgentRow, AgentState } from "../read/state.ts";
import { concerns, detail, duration } from "../read/words.ts";
import { waitsForPerson } from "../read/wait.ts";
import type { Item } from "../serve/server.ts";
import * as api from "./api.ts";
import { ChangeView } from "./ChangeView.tsx";
import { EventDialog } from "./EventDialog.tsx";
import { answerWanted, neighbours, filterTexts, filterWith, handoverKey, handoverLink, hashFor, oneAtATime, itemKey, showsUnattributed, menuShown, needsInputHref, parseHash, stepText, STREAM_START, takenBackText, streamColumns, establishedBy, needsPersonItems, waitFilter, waitRowKeys, statusMark, markText, nameTaken, builtInFilters, readSavedFilters, writeSavedFilters, SAVED_FILTERS_KEY, type SavedFilter, tabTitle, teamSince, teamWorksOn, whenShort, writingLines, type Question, type View } from "./format.ts";
import { texts } from "./texts.ts";

const POLL_MS = 2000;
const LEDGER_POLL_MS = 10_000;

/**
 * Calls `fn` now and every `ms` while `active`. A call that gives its promise
 * is not made again while its last answer is still on its way (#85).
 */
function usePoll(fn: () => Promise<unknown> | void, ms: number, active = true) {
  useEffect(() => {
    if (!active) return;
    const call = oneAtATime(fn);
    call();
    const id = setInterval(call, ms);
    return () => clearInterval(id);
  }, [fn, ms, active]);
}

export function App() {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const changed = () => setRoute(parseHash(location.hash));
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  const view = route.view;
  const [error, setError] = useState<string | null>(null);
  const fail = useCallback((e: unknown) => setError((e as Error).message), []);

  // The projects: the one in the address when it is there, else the server's default.
  const [projects, setProjects] = useState<api.Projects | null>(null);
  usePoll(
    useCallback(() => api.projects().then(setProjects, fail), [fail]),
    // #102: often enough to say soon that nobody writes a project.
    LEDGER_POLL_MS,
  );
  const unwritten = writingLines(projects);
  const project = projects === null ? null : (projects.projects.find((p) => p.name === route.project)?.name ?? projects.default);
  api.setProject(project);

  const [agents, setAgents] = useState<api.Agents | null>(null);
  usePoll(
    useCallback(() => {
      if (project !== null) return api.agents().then((a) => (setAgents(a), setError(null)), fail);
    }, [fail, project]),
    POLL_MS,
  );

  // The agents that need input: in the tab title, the header and, when turned on, a notification.
  const needing = useMemo(() => (agents?.rows ?? []).filter((r) => r.state === "needs-input").map((r) => r.agent), [agents]);
  const [notify, setNotify] = useNotify();
  const seen = useRef<Set<string> | null>(null);
  useEffect(() => {
    document.title = tabTitle(needing.length);
    if (seen.current !== null && notify === "on") {
      for (const agent of needing) if (!seen.current.has(agent)) new Notification(texts.team.notification(agent));
    }
    seen.current = new Set(needing);
  }, [needing, notify]);

  const [ledger, setLedger] = useState<api.LedgerState | null>(null);
  usePoll(
    useCallback(() => {
      if (project !== null) return api.ledger().then(setLedger, fail);
    }, [fail, project]),
    LEDGER_POLL_MS,
  );

  return (
    <div className="min-h-screen">
      <Header view={view} project={project} projects={projects} unwritten={unwritten.filter((u) => !u.written).map((u) => u.project)} />
      <main key={project ?? ""} className="mx-auto flex max-w-[1360px] flex-col gap-5 px-4 py-6 sm:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex flex-col gap-1">
            <h1 className="m-0 text-[26px] font-semibold tracking-tight">{view === "overview" ? texts.overview.title : view === "change" ? texts.change.title : texts.title}</h1>
            <span className="text-[13px] text-mute">{view === "overview" ? texts.overview.subtitle : view === "change" ? texts.change.subtitle : texts.subtitle}</span>
          </div>
          <div className="flex-1" />
          {needing.length > 0 && (
            <a href={needsInputHref(project)} className="flex items-center gap-2 rounded-full bg-accent px-3.5 py-2.5 text-sm font-semibold text-white no-underline">
              <span className="h-2 w-2 rounded-full bg-white" />
              {texts.needsInput(needing.length)}
            </a>
          )}
          <LedgerBadge ledger={ledger} />
        </div>
        {error && (
          <p role="alert" className="m-0 rounded-xl border border-line bg-error-pale px-4 py-3 text-error-ink">
            {texts.error(error)}
          </p>
        )}
        {unwritten.map((u) => (
          // #102: a ledger that is shown and not written looks alive and is not.
          <p key={u.project} role="status" className="m-0 rounded-xl border border-line bg-warn-pale px-4 py-3 text-warn-ink">
            {u.line}
          </p>
        ))}
        {project === null ? null : view === "overview" ? (
          // #81: the team right now first, then the figures of the period: both are of the project picked.
          <>
            <Team agents={agents} notify={notify} onNotify={setNotify} />
            <Overview onError={fail} project={project} />
          </>
        ) : view === "change" ? (
          <ChangeView what={route.what ?? null} project={project} onError={fail} />
        ) : (
          <Stream agents={agents} ledger={ledger} onError={fail} project={project} served={projects?.projects.length ?? 1} unwritten={unwritten.filter((u) => !u.written).map((u) => u.project)} />
        )}
      </main>
    </div>
  );
}

function Header({ view, project, projects, unwritten }: { view: View; project: string | null; projects: api.Projects | null; unwritten: string[] }) {
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
          <a href={hashFor("overview", project)} aria-current={view === "overview" ? "page" : undefined} className={tab(view === "overview")}>
            {texts.nav.overview}
          </a>
          <a href={hashFor("stream", project)} aria-current={view === "stream" ? "page" : undefined} className={tab(view === "stream")}>
            {texts.nav.stream}
          </a>
          <a href={hashFor("change", project)} aria-current={view === "change" ? "page" : undefined} className={tab(view === "change")}>
            {texts.nav.change}
          </a>
        </nav>
        <div className="flex-1" />
        {menuShown(view, projects) && projects ? (
          <label className="flex items-center gap-2 text-[13px] text-pale">
            {texts.project}
            <select
              value={project ?? ""}
              onChange={(e) => (location.hash = hashFor(view, e.target.value))}
              className="min-h-11 rounded-lg border-0 bg-white px-3 text-sm text-ink"
            >
              {projects.projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                  {unwritten.includes(p.name) ? texts.unwritten : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          // The event log is every project (#79): it names none here.
          view !== "stream" && project && <span className="font-mono text-[13px] text-pale">{project}</span>
        )}
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

function Overview({ onError, project }: { onError: (e: unknown) => void; project: string }) {
  const [data, setData] = useState<{ figures: KeyFigures; handovers: Handover[] } | null>(null);
  usePoll(
    useCallback(() => api.overview().then(setData, onError), [onError]),
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
        // #38: nothing to say, and no tile, when no merged change was read against a requirement.
        ...(f.requirementsNamed.merged > f.requirementsNamed.unrecorded
          ? [
              {
                label: texts.overview.named,
                value: texts.overview.namedValue(f.requirementsNamed.named, f.requirementsNamed.merged - f.requirementsNamed.unrecorded),
                note: texts.overview.namedNote(f.periodDays, f.requirementsNamed.without, f.requirementsNamed.unrecorded),
              },
            ]
          : []),
        ...(showsUnattributed(f) ? [{ label: texts.overview.unattributed, value: String(f.unattributed!.count), note: texts.overview.unattributedNote(f.periodDays) }] : []),
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
      {f && showsUnattributed(f) && f.unattributed!.changes.length > 0 && (
        <p className="m-0 flex flex-wrap gap-x-3 gap-y-1 text-[13px] text-mute">
          {texts.overview.unattributedList}
          {f.unattributed!.changes.map((c) => (
            <a key={c} href={hashFor("change", project, `change:${c}`)} className="font-mono text-ink">
              {c}
            </a>
          ))}
        </p>
      )}
      {f && f.configChanges.length > 0 && (
        <section aria-labelledby="cfg-h" className="flex flex-col gap-2 rounded-xl border border-line bg-warn-pale px-6 py-4">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <h2 id="cfg-h" className="m-0 text-base font-semibold text-warn-ink">
              {texts.overview.configHeading}
            </h2>
            <span className="text-[13px] text-mute">{texts.overview.configNote(f.periodDays)}</span>
          </div>
          {f.configChanges.map((c) => (
            <div key={`${c.change}-${c.time}`} className="flex flex-wrap gap-x-3 font-mono text-[13px]">
              <span className="text-mute">{whenShort(c.time, Date.now())}</span>
              <a href={hashFor("change", project, `change:${c.change}`)} className="text-ink">
                {texts.overview.change(c.change)}
              </a>
              <span>{c.paths.join(", ")}</span>
            </div>
          ))}
        </section>
      )}
      <section aria-labelledby="ho-h" className="flex flex-col gap-3.5 rounded-xl border border-line bg-white px-6 py-[22px]">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-2">
          <h2 id="ho-h" className="m-0 text-lg font-semibold">
            {texts.overview.heading}
          </h2>
          <span className="text-[13px] text-mute">{texts.overview.note}</span>
          <div className="flex-1" />
          <a href={hashFor("stream", project)} className="py-2.5 text-sm font-medium text-ink">
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
                  <tr key={handoverKey(h)} className="border-t border-line">
                    <td className="py-3 pr-3 font-mono text-[13px] whitespace-nowrap">{whenShort(h.time, Date.now())}</td>
                    <td className="p-3">
                      <a href={handoverLink(h, project)} className="font-medium text-ink">
                        {h.change !== undefined ? texts.overview.change(h.change) : texts.overview.task(h.task ?? "")}
                      </a>
                      {h.change !== undefined && h.task !== undefined && <div className="text-[13px] text-mute">{texts.overview.task(h.task)}</div>}
                    </td>
                    <td className="p-3 whitespace-nowrap">
                      {h.from} → {h.to === "merged" ? texts.overview.merged : h.to}
                      {h.via && <span className="text-mute"> {texts.via(h.via)}</span>}
                    </td>
                    <td className="p-3">
                      {stepText(h)}
                      {takenBackText(h, Date.now()) !== null && <div className="text-[13px] text-mute">{takenBackText(h, Date.now())}</div>}
                    </td>
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

type Notify = "off" | "on" | "blocked" | "unsupported";

/** Browser notifications, only after the viewer turns them on; the choice is kept in this browser. */
function useNotify(): [Notify, () => void] {
  const supported = typeof Notification !== "undefined";
  const [state, setState] = useState<Notify>(() => {
    if (!supported) return "unsupported";
    if (Notification.permission === "denied") return "blocked";
    try {
      return Notification.permission === "granted" && localStorage.getItem("howl.notify") === "on" ? "on" : "off";
    } catch {
      return "off";
    }
  });
  const toggle = useCallback(() => {
    if (!supported) return;
    const keep = (v: Notify) => {
      try {
        localStorage.setItem("howl.notify", v);
      } catch {
        // Kept for this visit only.
      }
      setState(v);
    };
    if (state === "on") return keep("off");
    Notification.requestPermission().then((p) => (p === "granted" ? keep("on") : setState(p === "denied" ? "blocked" : "off")));
  }, [state, supported]);
  return [state, toggle];
}

const STATE_STYLE: Record<AgentState, { pill: string; dot: string }> = {
  "needs-input": { pill: "bg-accent text-white font-semibold", dot: "bg-white" },
  working: { pill: "bg-ok-pale text-ok-ink", dot: "bg-ok" },
  waiting: { pill: "bg-[#e6eef8] text-[#1e3a5f]", dot: "bg-[#3b6ea5]" },
  idle: { pill: "bg-faint text-mute", dot: "bg-gray-400" },
  ended: { pill: "bg-faint text-mute", dot: "bg-ink" },
};

function Team({ agents, notify, onNotify }: { agents: api.Agents | null; notify: Notify; onNotify: () => void }) {
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
        <div className="flex-1" />
        {notify !== "unsupported" && (
          <button
            type="button"
            onClick={onNotify}
            disabled={notify === "blocked"}
            aria-pressed={notify === "on"}
            className="min-h-11 cursor-pointer rounded-lg border border-pale bg-white px-4 text-sm font-medium text-ink disabled:cursor-default disabled:text-mute"
          >
            {notify === "on" ? texts.team.notifyOff : notify === "blocked" ? texts.team.notifyBlocked : texts.team.notifyOn}
          </button>
        )}
      </div>
      <p className="m-0 mb-1 text-[13px] text-mute">{texts.team.limit}</p>
      {agents && rows.length === 0 ? (
        <p className="m-0 text-mute">{texts.team.empty}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] border-collapse text-sm">
            <thead>
              <tr className="text-left text-xs tracking-wider text-mute uppercase">
                <th scope="col" className={`${th} pl-0`}>{texts.team.cols.agent}</th>
                <th scope="col" className={th}>{texts.team.cols.state}</th>
                <th scope="col" className={th}>{texts.team.cols.role}</th>
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
    <tr className={`border-t border-faint ${row.state === "needs-input" ? "bg-accent-pale" : ""}`}>
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
      <td className="p-3 font-mono text-[13px]">{row.role ?? "–"}</td>
      <td className="p-3">
        <div className="font-medium">{teamWorksOn(row) || row.branch || "–"}</div>
        {teamWorksOn(row) && row.branch && <div className="text-[13px] text-mute">{row.branch}</div>}
        {row.gaps.length > 0 && <div className="text-[13px] font-medium text-warn-ink">{texts.team.missing(row.gaps)}</div>}
      </td>
      <td className="p-3 font-mono text-[13px]">{[row.model, row.effort].filter(Boolean).join(" · ") || "–"}</td>
      <td className="p-3 font-mono text-[13px]">{[row.tool, row.target].filter(Boolean).join(" ") || "–"}</td>
      <td className="py-3 pl-3 text-right font-mono text-[13px] whitespace-nowrap">{teamSince(row, now)}</td>
    </tr>
  );
}

/**
 * The event log (#79): every project the server serves in one list, narrowed by
 * the filter. `project` is the one picked in the menu: only for the link of a
 * row that names no project of its own.
 */
function Stream({ agents, ledger, onError, project, served, unwritten }: { agents: api.Agents | null; ledger: api.LedgerState | null; onError: (e: unknown) => void; project: string; served: number; unwritten: string[] }) {
  const [paused, setPaused] = useState(false);
  // #89: the tool calls are asked for with the box ticked; the filter line starts empty and holds what the reader wrote.
  const [tools, setTools] = useState<boolean>(STREAM_START.tools);
  const [draft, setDraft] = useState<string>(STREAM_START.filter);
  const [filters, setFilters] = useState<string[]>(() => filterTexts(STREAM_START.filter));
  const [filterError, setFilterError] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ events: number; reason: string } | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  // #110: the event open in the dialog, kept as it was picked: the list moves on under it.
  const [picked, setPicked] = useState<Item | null>(null);
  const filterLine = useRef<HTMLInputElement>(null);
  // #189: saved filters live in this browser; a browser that refuses storage still has the built-in ones.
  const [saved, setSaved] = useState<SavedFilter[]>(() => {
    try {
      return readSavedFilters(localStorage.getItem(SAVED_FILTERS_KEY));
    } catch {
      return [];
    }
  });
  const [storageRefused, setStorageRefused] = useState(false);
  const [saveName, setSaveName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [bandNote, setBandNote] = useState<string | null>(null);
  // The band's button that opened the dialog, so the focus goes back to it.
  const fromBand = useRef<string | null>(null);
  // The expression last applied: the pressed button follows it, not the box.
  const [applied, setApplied] = useState<string>(STREAM_START.filter);
  const keep = (next: SavedFilter[]) => {
    setSaved(next);
    try {
      localStorage.setItem(SAVED_FILTERS_KEY, writeSavedFilters(next));
      setStorageRefused(false);
    } catch {
      setStorageRefused(true);
    }
  };
  const applyFilter = (expression: string) => {
    setDraft(expression);
    setFilters(filterTexts(expression));
    setApplied(expression);
  };

  // #93: the question the page holds now. An answer to an older one is dropped.
  const now = useRef<Question>({ filters, tools });
  now.current = { filters, tools };

  const load = useCallback(() => {
    const asked: Question = { filters, tools };
    return api.events(filters, tools).then(
      (r) => {
        if (!answerWanted(asked, now.current)) return;
        setItems([...r.events].reverse());
        setFilterError(null);
        setFailed(r.failed ?? null);
      },
      (e: Error) => {
        if (!answerWanted(asked, now.current)) return;
        return filters.length > 0 ? setFilterError(e.message) : onError(e);
      },
    );
  }, [filters, tools, onError]);
  usePoll(load, POLL_MS, !paused);

  const needing = useMemo(() => waitRowKeys(items, agents?.rows ?? [], served > 1 ? project : null), [items, agents, served, project]);
  const cols = useMemo(() => streamColumns(items, served), [items, served]);
  // A click on a project or a repository in a row narrows the list to it.
  const narrow = (field: string, value: string) => {
    const next = filterWith(draft, field, value);
    setDraft(next);
    setFilters(filterTexts(next));
  };
  const button = "min-h-11 cursor-pointer rounded-lg px-4 text-sm font-medium";
  const th = "px-3 py-2.5 font-medium";

  return (
    <>
      <section aria-labelledby="stream-h" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <h2 id="stream-h" className="m-0 text-lg font-semibold">
            {texts.stream.heading}
          </h2>
          {served > 1 && <span className="text-[13px] text-mute">{texts.stream.all(served)}</span>}
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

        <Band
          agents={agents}
          project={served > 1 ? project : null}
          onOpen={(agent) => {
            // The event the wait rests on: the agent's latest wait for a person.
            api.events([waitFilter(agent, served > 1 ? project : null)], false, 5).then(
              (r) => {
                const found = [...r.events].reverse().find((i) => waitsForPerson(i.event));
                if (found) {
                  fromBand.current = agent;
                  setPicked(found);
                  setBandNote(null);
                } else setBandNote(texts.stream.band.noEvent);
              },
              (e: Error) => setBandNote(e.message),
            );
          }}
          note={bandNote}
        />

        <div role="group" aria-label={texts.stream.filtersLabel} className="flex flex-wrap items-center gap-2">
          {[...builtInFilters(), ...saved].map((f, i) => {
            const isSaved = i >= builtInFilters().length;
            const on = applied === f.expression;
            return (
              <span key={`${i}:${f.name}`} className="flex items-center">
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => applyFilter(f.expression)}
                  className={`${button} border ${isSaved ? "rounded-r-none" : ""} ${on ? "border-ink bg-ink text-white" : "border-pale bg-white text-ink"}`}
                >
                  {f.name}
                </button>
                {isSaved && (
                  <button
                    type="button"
                    aria-label={texts.stream.removeSaved(f.name)}
                    onClick={() => keep(saved.filter((_, j) => j !== i - builtInFilters().length))}
                    className={`${button} rounded-l-none border border-l-0 border-pale bg-white px-3 text-ink`}
                  >
                    ×
                  </button>
                )}
              </span>
            );
          })}
        </div>

        <form
          className="flex flex-wrap items-end gap-2.5 rounded-xl border border-line bg-white px-4 py-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters(filterTexts(draft));
            setApplied(draft);
          }}
        >
          <label className="flex flex-[1_1_420px] flex-col gap-1 text-[13px] text-mute">
            {texts.stream.filterLabel}
            <input
              type="text"
              ref={filterLine}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={'event.type.startsWith("review.") && event.project == "…"'}
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
              // The line only: the box stays as the reader set it.
              setDraft("");
              setFilters([]);
              setApplied("");
            }}
            className={`${button} border border-pale bg-white text-ink`}
          >
            {texts.stream.clear}
          </button>
          <input
            type="text"
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            aria-label={texts.stream.saveName}
            placeholder={texts.stream.saveName}
            className="min-h-11 rounded-lg border-[1.5px] border-pale bg-white px-3 text-sm text-ink"
          />
          <button
            type="button"
            disabled={saveName.trim() === "" || draft.trim() === ""}
            onClick={() => {
              const name = saveName.trim();
              const expression = draft.trim();
              if (nameTaken(name, saved)) return setSaveError(texts.stream.nameTaken);
              // The server's filter tries the expression first; its reason is shown.
              api.events(filterTexts(expression), false, 1).then(
                () => {
                  keep([...saved.filter((f) => f.name !== name), { name, expression }]);
                  setSaveName("");
                  setSaveError(null);
                },
                (e: Error) => setSaveError(e.message),
              );
            }}
            className={`${button} border border-pale bg-white text-ink disabled:cursor-default disabled:opacity-50`}
          >
            {texts.stream.save}
          </button>
          {saveError !== null && (
            <span className="basis-full text-[13px] text-error-ink" role="alert">
              {saveError}
            </span>
          )}
          {storageRefused && (
            <span className="basis-full text-[13px] text-warn-ink" role="status">
              {texts.stream.storageRefused}
            </span>
          )}
          <span className={`basis-full text-[13px] ${filterError ? "text-error-ink" : "text-mute"}`} role={filterError ? "alert" : undefined}>
            {filterError ?? texts.stream.filterHint}
          </span>
          {failed !== null && filterError === null && (
            <span className="basis-full text-[13px] text-warn-ink" role="status">
              {texts.stream.failed(failed.events, failed.reason)}
            </span>
          )}
        </form>

        <div className="overflow-hidden rounded-xl border border-line bg-white">
          <div className="max-h-[560px] overflow-auto" tabIndex={0} aria-label={texts.stream.heading}>
            <table className="w-full min-w-[960px] border-collapse font-mono text-[13px]">
              <thead className="sticky top-0 z-10">
                <tr className="bg-[#f7f8fa] text-left font-sans text-xs tracking-wider text-mute uppercase">
                  <th scope="col" className={th}>{texts.stream.cols.status}</th>
                  {cols.project && <th scope="col" className={th}>{texts.stream.cols.project}</th>}
                  {cols.repo && <th scope="col" className={th}>{texts.stream.cols.repo}</th>}
                  <th scope="col" className={th}>{texts.stream.cols.line}</th>
                  <th scope="col" className={th}>{texts.stream.cols.time}</th>
                  <th scope="col" className={th}>{texts.stream.cols.actor}</th>
                  <th scope="col" className={th}>{texts.stream.cols.type}</th>
                  <th scope="col" className={th}>{texts.stream.cols.subject}</th>
                  <th scope="col" className={th}>{texts.stream.cols.establishedBy}</th>
                  <th scope="col" className={th}>{texts.stream.cols.detail}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isPicked = picked !== null && itemKey(item) === itemKey(picked);
                  // The change and the task of a row are those of its own project.
                  const of = item.project ?? project;
                  const origin = establishedBy(item.event.source.kind);
                  const mark = statusMark(item);
                  // #189: status is a mark, not a fill; the selected row has an outline.
                  const bg = `${isPicked ? "bg-picked font-medium outline-[1.5px] -outline-offset-[1.5px] outline-ink outline" : item.from === "activity" ? "bg-[#fafbfc] text-mute" : "bg-white"}${origin.claimed ? " italic" : ""}`;
                  const needsPerson = needing.has(itemKey(item));
                  const label = item.from === "ledger" ? String(item.n) : "·";
                  return (
                    <tr
                      key={itemKey(item)}
                      // #110: a click anywhere on the row opens the event; a link in it goes where it leads.
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest("a")) {
                          fromBand.current = null;
                          setPicked(item);
                        }
                      }}
                      className={`cursor-pointer border-t border-line hover:bg-picked ${bg}`}
                    >
                      <td className={`px-3 py-2 text-center font-sans font-semibold ${needsPerson ? "border-l-[6px] border-l-ink" : ""}`} title={markText(mark) || undefined}>
                        <span aria-hidden="true">{mark}</span>
                        <span className="sr-only">{markText(mark)}</span>
                      </td>
                      {cols.project && (
                        <td className="px-3 py-2 whitespace-nowrap">
                          {item.project !== undefined ? `${item.project}${unwritten.includes(item.project) ? texts.unwritten : ""}` : "–"}
                        </td>
                      )}
                      {cols.repo && (
                        <td className="px-3 py-2 whitespace-nowrap">
                          {item.event.repo ?? "–"}
                        </td>
                      )}
                      <td className="p-0">
                        <button
                          type="button"
                          aria-label={texts.stream.showEvent(item.from === "ledger" ? label : item.event.type)}
                          aria-haspopup="dialog"
                          data-event={itemKey(item)}
                          className="min-h-10 w-full cursor-pointer border-0 bg-transparent px-3 text-left font-[inherit] text-inherit"
                        >
                          {label}
                        </button>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{whenShort(item.event.time, Date.now())}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {item.by ? (
                          <>
                            {item.by} <span className="text-mute">{item.event.actor ? texts.via(item.event.actor.id) : texts.matched}</span>
                          </>
                        ) : (
                          (item.event.actor?.id ?? "–")
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{item.event.type}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {item.event.change !== undefined ? (
                          <a href={hashFor("change", of, `change:${item.event.change}`)} className="text-ink">
                            {concerns(item.event)}
                          </a>
                        ) : item.event.task !== undefined ? (
                          <a href={hashFor("change", of, `task:${item.event.task}`)} className="text-ink">
                            {concerns(item.event)}
                          </a>
                        ) : (
                          concerns(item.event)
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <span
                          title={texts.stream.origin[origin.code]}
                          className={`mr-2 inline-block rounded border-[1.5px] border-ink px-1.5 py-0.5 font-sans text-[11px] font-semibold tracking-wider ${origin.code === "SOURCE" ? "bg-ink text-white" : "bg-white text-ink"} ${origin.code === "UNKNOWN" ? "border-dashed" : ""}`}
                        >
                          <span aria-hidden="true">{origin.mark}</span> {origin.code}
                        </span>
                        <span className="text-mute">{item.event.source.adapter}</span>
                      </td>
                      <td className="px-3 py-2 font-sans">
                        {needsPerson && <strong className="mr-2 font-semibold">{texts.stream.needsPerson}</strong>}
                        {detail(item.event)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {items.length === 0 && <div className="border-t border-line px-4 py-2.5 text-[13px] text-mute">{texts.stream.empty}</div>}
          <div className="flex flex-wrap gap-x-4 gap-y-1 border-t border-line bg-[#f7f8fa] px-4 py-2.5 font-sans text-[13px] text-mute">
            <span className={ledger !== null && !ledger.ok ? "font-medium text-error-ink" : ""}>
              {ledger === null ? texts.stream.bar.unknown : ledger.ok ? texts.stream.bar.verified(ledger.lines) : texts.stream.bar.broken(ledger.line)}
            </span>
            <span>{texts.stream.bar.displayed(items.length)}</span>
            <span>{tools ? texts.stream.bar.withTools : texts.stream.bar.evidenceOnly}</span>
            <span>{texts.stream.bar.people}</span>
          </div>
        </div>
      </section>

      {picked !== null && (
        <EventDialog
          item={picked}
          beside={neighbours(items, itemKey(picked))}
          onStep={(key) => setPicked(items.find((i) => itemKey(i) === key) ?? picked)}
          onPick={setPicked}
          onNarrow={(field, value) => {
            setPicked(null);
            narrow(field, value);
            // The list is another one now: the focus goes to the line that says why.
            requestAnimationFrame(() => filterLine.current?.focus());
          }}
          onClose={() => {
            // Back to the row of the event that was shown last, when it is still in the list.
            const key = itemKey(picked);
            setPicked(null);
            const band = fromBand.current;
            fromBand.current = null;
            requestAnimationFrame(() => {
              if (band !== null) {
                for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-band]")) if (b.dataset.band === band) return b.focus();
              }
              for (const b of document.querySelectorAll<HTMLButtonElement>("button[data-event]")) if (b.dataset.event === key) return b.focus();
            });
          }}
        />
      )}
    </>
  );
}

/**
 * #190: what needs a person, above the event list: one button for each agent
 * that waits for one, the longest wait first, each saying who established it.
 * It is not a live region: the page polls, and a region would be read at every round.
 */
function Band({ agents, project, onOpen, note }: { agents: api.Agents | null; project: string | null; onOpen: (agent: string) => void; note: string | null }) {
  const items = agents === null ? [] : needsPersonItems(agents.rows, agents.now);
  return (
    <section aria-labelledby="band-h" className="flex flex-col gap-2 rounded-xl border border-line bg-white px-4 py-3">
      <h3 id="band-h" className="m-0 text-sm font-semibold">
        {texts.stream.band.heading(items.length, project)}
      </h3>
      {agents === null ? null : items.length === 0 ? (
        <p className="m-0 text-[13px] text-mute">{texts.stream.band.empty}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {items.map((it) => (
            <li key={it.agent}>
              <button
                type="button"
                data-band={it.agent}
                onClick={() => onOpen(it.agent)}
                className={`flex min-h-11 w-full cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-pale border-l-[6px] border-l-ink bg-white px-3 py-2 text-left font-sans text-sm text-ink ${it.established.claimed ? "italic" : ""}`}
              >
                <span aria-hidden="true" className="font-semibold">
                  {it.mark}
                </span>
                <span className="sr-only">{`${markText(it.mark)}. ${texts.stream.band.open}`}</span>
                <span className="font-semibold">{it.agent}</span>
                <span>{it.subject}</span>
                <span className="text-mute">{it.since}</span>
                <span className="flex items-center gap-2">
                  <span
                    title={texts.stream.origin[it.established.code]}
                    className="inline-block rounded border-[1.5px] border-ink bg-white px-1.5 py-0.5 text-[11px] font-semibold tracking-wider not-italic"
                  >
                    <span aria-hidden="true">{it.established.mark}</span> {it.established.code}
                  </span>
                  <span className="text-mute">{it.session !== undefined ? texts.stream.band.session(it.session) : texts.stream.band.noSession}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {note !== null && <p className="m-0 text-[13px] text-warn-ink">{note}</p>}
    </section>
  );
}
