// The event dialog of the dashboard: one event in numbered parts of its provenance, with howl's own reading kept apart (#110, #191).
// @code_class reading
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Item } from "../serve/server.ts";
import * as api from "./api.ts";
import { decodedFields, dialogHeading, indentStored, itemKey, lineToCopy, narrowOf, partIdentity, partKept, partSource, partTime, utcTime, whenShort } from "./format.ts";
import { texts } from "./texts.ts";

/**
 * #110: one event of the event log in a dialog: what the page reads of it on
 * the left, the line as it is stored on the right, to be held against each
 * other. The browser's own dialog, opened modal: Escape and a click beside it
 * close it.
 */
export function EventDialog({
  item,
  beside,
  onStep,
  onPick,
  onNarrow,
  onClose,
}: {
  item: Item;
  /** The events beside this one in the list the page shows. Absent where there is no list to step through (the change view). */
  beside?: { newer: string | null; older: string | null };
  onStep?: (key: string) => void;
  onPick: (item: Item) => void;
  /** Absent where there is no filter to narrow (the change view): the button is not shown. */
  onNarrow?: (field: "project" | "repo", value: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // The focus starts on Close, which is never off: a button that goes off under the focus would lose it.
    close.current?.focus();
  }, []);
  useEffect(() => setCopied(false), [item]);
  // #191: the line's provenance, read once for each event shown: a tool call is not a line of the ledger.
  const [prov, setProv] = useState<{ key: string; answer?: LineAnswer; error?: string } | null>(null);
  // A related line opened from the dialog comes with its answer: it is not read twice.
  const preloaded = useRef<{ key: string; answer: LineAnswer } | null>(null);
  useEffect(() => {
    if (item.from !== "ledger" || item.n === undefined) {
      setProv(null);
      return;
    }
    const key = itemKey(item);
    if (preloaded.current?.key === key) {
      setProv(preloaded.current);
      preloaded.current = null;
      return;
    }
    let live = true;
    setProv({ key });
    api.line(item.project, item.n).then(
      (answer) => live && setProv({ key, answer }),
      (e: unknown) => live && setProv({ key, error: (e as Error).message }),
    );
    return () => {
      live = false;
    };
  }, [item]);
  const answer = prov !== null && prov.key === itemKey(item) ? prov.answer : undefined;
  const heading = useRef<HTMLHeadingElement>(null);
  // #191: a related event may be outside the list: it is read from the ledger, and the focus goes to the heading, as the button that had it is gone.
  const openLine = (n: number) => {
    api.line(item.project, n).then(
      (a) => {
        const next = a.item as Item;
        preloaded.current = { key: itemKey(next), answer: a };
        onPick(next);
        requestAnimationFrame(() => heading.current?.focus());
      },
      (e: unknown) => setProv({ key: itemKey(item), answer, error: (e as Error).message }),
    );
  };
  // The arrow keys are heard on the window, wherever the focus is inside the dialog.
  const newer = beside?.newer ?? null;
  const older = beside?.older ?? null;
  useEffect(() => {
    if (beside === undefined || onStep === undefined) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      e.preventDefault();
      const to = e.key === "ArrowUp" ? newer : older;
      if (to !== null) onStep(to);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [beside !== undefined, newer, older, onStep]);
  // A click beside the dialog closes it only when it began there: a text marked from inside and let go outside does not.
  const pressedBeside = useRef(false);
  // Two whole sets of classes: a colour given twice is decided by the stylesheet's order, not by this line's.
  // A step that cannot be taken is marked off and keeps the focus: `disabled` would drop it to the page behind.
  const shape = "min-h-11 cursor-pointer rounded-lg px-4 text-sm font-medium aria-disabled:cursor-default aria-disabled:opacity-40";
  const button = `${shape} border border-pale bg-white text-ink`;
  const closeButton = `${shape} border-0 bg-ink text-white`;
  return (
    <dialog
      ref={ref}
      aria-labelledby="event-h"
      onClose={onClose}
      // A press and a release on the dialog itself, not on what it holds, is a click beside its content.
      onMouseDown={(e) => {
        pressedBeside.current = e.target === ref.current;
      }}
      onClick={(e) => {
        if (e.target === ref.current && pressedBeside.current) ref.current.close();
      }}
      className="m-auto w-[min(1200px,calc(100vw-32px))] max-w-none rounded-xl border border-line bg-white p-0 text-ink backdrop:bg-black/40"
    >
      <div className="flex max-h-[calc(100vh-48px)] flex-col">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3.5">
          <h2 id="event-h" ref={heading} tabIndex={-1} className="m-0 text-base font-semibold">
            {dialogHeading(item)}
          </h2>
          <span className="font-mono text-[13px] text-mute">{item.event.type}</span>
          <div className="flex-1" />
          {beside !== undefined && onStep !== undefined && (
            <>
              <button type="button" aria-disabled={newer === null} onClick={() => newer !== null && onStep(newer)} className={button}>
                {texts.dialog.newer}
              </button>
              <button type="button" aria-disabled={older === null} onClick={() => older !== null && onStep(older)} className={button}>
                {texts.dialog.older}
              </button>
            </>
          )}
          <button type="button" ref={close} onClick={() => ref.current?.close()} className={closeButton}>
            {texts.dialog.close}
          </button>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-2">
          <div className="flex min-w-0 flex-col gap-4 px-5 py-[18px]">
            <span className="text-[13px] text-mute">{texts.provenance.heading}</span>
            {item.from === "ledger" && prov?.error !== undefined && <p role="alert" className="m-0 text-[13px] text-error-ink">{texts.provenance.failed(prov.error)}</p>}
            {item.from === "ledger" && answer === undefined && prov?.error === undefined && <p className="m-0 text-[13px] text-mute">{texts.provenance.loading}</p>}
            <Part id="p-source" title={texts.provenance.parts.source}>
              <Facts rows={sourceRows(item)} />
            </Part>
            <Part id="p-time" title={texts.provenance.parts.time}>
              <Facts rows={timeRows(item)} />
            </Part>
            <Part id="p-identity" title={texts.provenance.parts.identity}>
              <IdentityPart item={item} answer={answer} />
            </Part>
            <Part id="p-integrity" title={texts.provenance.parts.integrity}>
              <IntegrityPart item={item} answer={answer} />
            </Part>
            <Part id="p-kept" title={texts.provenance.parts.kept}>
              <KeptPart item={item} />
            </Part>
            <Part id="p-related" title={texts.provenance.parts.related}>
              <RelatedPart item={item} answer={answer} onOpen={openLine} />
            </Part>
            <section aria-labelledby="p-reading" className="flex flex-col gap-2.5 rounded-lg border-2 border-dashed border-pale px-4 py-3">
              <h3 id="p-reading" className="m-0 text-sm font-semibold">
                {texts.provenance.parts.reading}
              </h3>
              <p className="m-0 text-[13px] text-mute">{texts.provenance.reading}</p>
              <dl className="m-0 grid grid-cols-[minmax(110px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-[13px]">
                {decodedFields(item, undefined, answer?.issuer).map((f) => {
                  const by = onNarrow === undefined ? null : narrowOf(f, item);
                  return (
                    <div key={f.k} className="contents">
                      <dt className="text-mute">{f.k}</dt>
                      <dd className="m-0 font-mono [overflow-wrap:anywhere]">
                        {f.v}
                        {by !== null && (
                          <button
                            type="button"
                            onClick={() => onNarrow?.(by.field, by.value)}
                            aria-label={texts.stream.narrow(by.field, by.value)}
                            className="ml-3 cursor-pointer border-0 bg-transparent p-0 font-sans text-[13px] text-ink underline decoration-pale underline-offset-2"
                          >
                            {texts.dialog.only}
                          </button>
                        )}
                      </dd>
                    </div>
                  );
                })}
              </dl>
            </section>
          </div>
          <section aria-labelledby="raw-h" className="flex min-w-0 flex-col gap-2.5 bg-ink px-5 py-[18px] text-gray-200">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <h3 id="raw-h" className="m-0 text-base font-semibold text-white">
                {texts.raw.heading}
              </h3>
              <span className="text-[13px] text-pale">{texts.raw.sub}</span>
              <div className="flex-1" />
              <button
                type="button"
                title={texts.dialog.copyHint}
                onClick={() => {
                  void navigator.clipboard?.writeText(lineToCopy(item)).then(() => setCopied(true), () => setCopied(false));
                }}
                className="min-h-9 cursor-pointer rounded-lg border border-pale bg-transparent px-3 text-[13px] font-medium text-white"
              >
                {copied ? texts.dialog.copied : texts.dialog.copy}
              </button>
            </div>
            <pre className="m-0 overflow-auto font-mono text-xs leading-relaxed">{indentStored(item.raw)}</pre>
          </section>
        </div>
      </div>
    </dialog>
  );
}

type LineAnswer = Awaited<ReturnType<typeof api.line>>;

/** #191: one numbered part of the event dialog. */
function Part({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-1.5">
      <h3 id={id} className="m-0 text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** #191: the facts of a part, a name and a value each. */
function Facts({ rows }: { rows: { k: string; v: string }[] }) {
  return (
    <dl className="m-0 grid grid-cols-[minmax(110px,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
      {rows.map((r) => (
        <div key={r.k} className="contents">
          <dt className="text-mute">{r.k}</dt>
          <dd className="m-0 font-mono [overflow-wrap:anywhere]">{r.v}</dd>
        </div>
      ))}
    </dl>
  );
}

function sourceRows(item: Item): { k: string; v: string }[] {
  const s = partSource(item);
  const t = texts.provenance.source;
  return [{ k: t.adapter, v: s.adapter }, { k: t.kind, v: s.kind }, ...s.references.map((r) => ({ k: `${t.reference}: ${r.k}`, v: r.v }))];
}

function timeRows(item: Item): { k: string; v: string }[] {
  const t = partTime(item);
  return [
    { k: texts.provenance.time.stated, v: `${t.stated}, ${t.by}` },
    { k: texts.provenance.time.received, v: t.received },
  ];
}

function IdentityPart({ item, answer }: { item: Item; answer: LineAnswer | undefined }) {
  const t = texts.provenance.identity;
  // While the line is read, its signature is not known yet: nothing is said of it.
  const waiting = item.from === "ledger" && answer === undefined;
  // The issuer is the answer's: until it is read, the most restrictive words are never used, as nothing is said of the signature.
  const id = partIdentity(item, item.from === "ledger" ? (answer?.signature ?? null) : undefined, answer?.issuer ?? { id: null, pinned: false });
  return (
    <>
      <Facts rows={[{ k: t.actor, v: id.actor }, ...(waiting ? [] : [{ k: t.signature, v: id.signature }])]} />
      {id.note !== null && <p className="m-0 text-[13px] text-mute">{id.note}</p>}
      {!waiting && id.limit !== null && <p className="m-0 text-[13px] text-mute">{id.limit}</p>}
    </>
  );
}

function IntegrityPart({ item, answer }: { item: Item; answer: LineAnswer | undefined }) {
  const t = texts.provenance.integrity;
  if (item.from !== "ledger") return <p className="m-0 text-[13px] text-mute">{t.tool}</p>;
  const rows = [
    { k: t.line, v: String(item.n) },
    { k: t.prev, v: item.prev ?? t.firstLine },
    { k: t.hash, v: item.hash ?? "" },
  ];
  if (answer !== undefined) {
    const c = answer.checkpoint;
    const chain = answer.intact ? t.intact : answer.broken === null ? t.unchecked : answer.doubted ? t.doubted(answer.broken) : t.broken(answer.broken);
    rows.push({ k: t.chain, v: answer.intact && answer.last ? `${chain}; ${t.last}` : chain });
    rows.push({ k: t.checkpoint, v: c === null ? t.none : c.holds ? t.covered(utcTime(c.time), c.lines, c.head.slice(0, 12)) : t.notHeld(utcTime(c.time), c.lines) });
  }
  return (
    <>
      <Facts rows={rows} />
      {answer !== undefined && <p className="m-0 text-[13px] text-mute">{t.where}</p>}
    </>
  );
}

function KeptPart({ item }: { item: Item }) {
  const k = partKept(item);
  const t = texts.provenance.kept;
  return (
    <>
      <p className="m-0 text-[13px]">{k.note}</p>
      {k.data === null ? (
        <p className="m-0 text-[13px] text-mute">{t.noData}</p>
      ) : (
        <>
          <span className="text-[13px] text-mute">{t.data}</span>
          <pre className="m-0 overflow-auto rounded border border-line bg-[#f7f8fa] p-2 font-mono text-xs">{k.data}</pre>
        </>
      )}
    </>
  );
}

function RelatedPart({ item, answer, onOpen }: { item: Item; answer: LineAnswer | undefined; onOpen: (n: number) => void }) {
  const t = texts.provenance.related;
  if (item.from !== "ledger") return <p className="m-0 text-[13px] text-mute">{t.tool}</p>;
  if (answer === undefined) return null;
  if (item.event.task === undefined && item.event.change === undefined) return <p className="m-0 text-[13px] text-mute">{t.noSubject}</p>;
  const r = answer.related;
  if (r.before.length === 0 && r.after.length === 0) return <p className="m-0 text-[13px] text-mute">{t.none}</p>;
  const list = (title: string, rows: typeof r.before, more: number, moreFirst: boolean) =>
    rows.length === 0 ? null : (
      <div className="flex flex-col gap-1">
        <span className="text-[13px] text-mute">{title}</span>
        {moreFirst && more > 0 && <span className="text-[13px] text-mute">{t.more(more)}</span>}
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {rows.map((e) => (
            <li key={e.n}>
              <button
                type="button"
                onClick={() => onOpen(e.n)}
                className="flex min-h-9 w-full cursor-pointer flex-wrap gap-x-3 rounded-lg border border-pale bg-white px-3 py-1 text-left font-sans text-[13px] text-ink"
              >
                <span className="font-semibold">{t.open(e.n)}</span>
                <span className="font-mono">{e.type}</span>
                {e.actor !== undefined && <span>{e.actor}</span>}
                <span className="text-mute">{whenShort(e.time, answer.now)}</span>
              </button>
            </li>
          ))}
        </ul>
        {!moreFirst && more > 0 && <span className="text-[13px] text-mute">{t.more(more)}</span>}
      </div>
    );
  return (
    <>
      {list(t.before, r.before, r.beforeMore, true)}
      {list(t.after, r.after, r.afterMore, false)}
    </>
  );
}
