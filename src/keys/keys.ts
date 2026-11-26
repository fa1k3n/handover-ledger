// Signed claims with a key per assignment (#23). The issuer key of a project
// issues an Ed25519 key for one assignment (agent, task, change, role, window);
// the session's hook signs its events with it; the check finds every signed
// event's key in the ledger and holds it to what was issued.
//
// Said plainly: on one machine with one user, that user can read an agent's key.
// Signing binds every claim to an issued assignment, makes a later change show
// and bounds misuse to the key's window; keeping keys out of the user's reach is
// a step of its own.
// @code_class evidence
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerError } from "../ledger/errors.ts";
import { fixedForm } from "../ledger/fixed.ts";
import { isDay } from "../ledger/time.ts";
import type { LedgerEvent } from "../ledger/schema.ts";

/** The raw public key, base64url, and its id: the SHA-256 of the raw bytes. */
export function publicOf(key: KeyObject): { id: string; public: string } {
  const pub = key.type === "private" ? createPublicKey(key) : key;
  const x = pub.export({ format: "jwk" }).x as string;
  return { id: createHash("sha256").update(Buffer.from(x, "base64url")).digest("hex"), public: x };
}

function publicFrom(x: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x }, format: "jwk" });
}

/** What is signed: the event as the ledger keeps it, without its signature. */
function payload(event: LedgerEvent): Buffer {
  const { sig: _sig, ...rest } = JSON.parse(JSON.stringify(event)) as LedgerEvent;
  return fixedForm(rest);
}

/** The event with its signature by `key`. */
export function signEvent(event: LedgerEvent, key: KeyObject): LedgerEvent {
  // The check of a signature builds an Ed25519 key from the issued public key: a signature by another kind of key, under an id never issued, could never hold.
  if (key.asymmetricKeyType !== "ed25519") throw new LedgerError("not an Ed25519 key");
  const { id } = publicOf(key);
  const value = sign(null, payload(event), key).toString("base64url");
  return { ...event, sig: { key: id, value } };
}

export function signatureHolds(event: LedgerEvent, publicKey: string): boolean {
  if (!event.sig) return false;
  try {
    return verify(null, payload(event), publicFrom(publicKey), Buffer.from(event.sig.value, "base64url"));
  } catch {
    return false;
  }
}

// #199: a public key is held to Ed25519 by howl's own check, before any signature is checked against it, so that the
// verdict on a weak key never depends on the crypto library or the OpenSSL that Node is built with. The steps are those
// of decoding a point (RFC 8032, 5.1.3), with y read modulo p as the Rust's library reads it.
const P = 2n ** 255n - 19n;
const mod = (a: bigint): bigint => ((a % P) + P) % P;
function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
  }
  return result;
}
const inverse = (a: bigint): bigint => power(a, P - 2n);
const D = mod(-121665n * inverse(121666n));
const SQRT_M1 = power(2n, (P - 1n) / 4n);

/** The sum of two points of the curve, by the complete addition law of twisted Edwards curves with a = -1. */
function add([x1, y1]: [bigint, bigint], [x2, y2]: [bigint, bigint]): [bigint, bigint] {
  const t = mod(D * x1 * x2 * y1 * y2);
  return [mod((x1 * y2 + y1 * x2) * inverse(1n + t)), mod((y1 * y2 + x1 * x2) * inverse(1n - t))];
}

/**
 * Why a raw public key is refused, or null when it is a key: not 32 bytes; not a point of the curve; not in its
 * canonical form (y not below p, or x zero with its sign set); of small order (eight times it is the identity).
 */
export function publicKeyFault(raw: Uint8Array): string | null {
  if (raw.length !== 32) return "not 32 bytes";
  const sign = raw[31]! >> 7;
  let written = 0n;
  for (let i = 31; i >= 0; i--) written = (written << 8n) | BigInt(i === 31 ? raw[i]! & 0x7f : raw[i]!);
  const y = mod(written);
  const u = mod(y * y - 1n);
  const v = mod(D * y * y + 1n);
  let x = mod(u * power(v, 3n) * power(u * power(v, 7n), (P - 5n) / 8n));
  const vx2 = mod(v * x * x);
  if (vx2 === mod(-u)) x = mod(x * SQRT_M1);
  else if (vx2 !== u) return "not a point of the curve";
  if (written >= P || (x === 0n && sign === 1)) return "not in its canonical form";
  if (Number(x & 1n) !== sign) x = mod(-x);
  let point: [bigint, bigint] = [x, y];
  for (let i = 0; i < 3; i++) point = add(point, point);
  return point[0] === 0n && point[1] === 1n ? "of small order" : null;
}

/** Why a public key as a ledger line gives it (base64url, read as Node reads it) is refused, or null. */
function keyFault(value: unknown): string | null {
  if (typeof value !== "string") return "not a text in base64url";
  let verdict = keyVerdicts.get(value);
  if (verdict === undefined) {
    verdict = publicKeyFault(Buffer.from(value, "base64url"));
    // The issuer key is the same on every key line, and the readers check the ledger again when it changes.
    if (keyVerdicts.size >= 1024) keyVerdicts.clear();
    keyVerdicts.set(value, verdict);
  }
  return verdict;
}

/** The verdicts of `keyFault`, by the text of the key: at most 1,024. */
const keyVerdicts = new Map<string, string | null>();

/** The SHA-256 of a key in base64url, read as Node reads it, in hex: a key's id. */
const idOf = (text: string): string => createHash("sha256").update(Buffer.from(text, "base64url")).digest("hex");

/** An ISO time with a zone, as a key's window is written: a date, `T`, a time with seconds, a fraction of up to nine digits, then `Z` or an offset. */
const WINDOW = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** #199: the time of one end of a key's window, in milliseconds; NaN when it is not an ISO time with a zone, or not a real day and time. */
export function windowTime(value: unknown): number {
  const m = typeof value === "string" ? WINDOW.exec(value) : null;
  if (m === null) return Number.NaN;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  const [offsetHours, offsetMinutes] = [m[7], m[8]].map((x) => (x === undefined ? 0 : Number(x))) as [number, number];
  if (!isDay(year, month, day) || hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59) return Number.NaN;
  return Date.parse(value as string);
}

/** A private key in PEM, from a file. */
export function readKey(file: string): KeyObject {
  return createPrivateKey(readFileSync(file));
}

function writeKey(file: string, key: KeyObject): void {
  writeFileSync(file, key.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** The project's issuer key, made on first use (mode 0600). */
export function issuerKey(configDir: string): { key: KeyObject; made: boolean } {
  const file = join(configDir, "issuer.key");
  if (existsSync(file)) return { key: readKey(file), made: false };
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  writeKey(file, privateKey);
  return { key: privateKey, made: true };
}

/** The last time a key's window can end (#199, after the review): `toISOString` writes a year after 9999 in another form, which no window may have. */
export const LAST_WINDOW = Date.UTC(9999, 11, 31, 23, 59, 59, 999);
export const PAST_LAST_WINDOW = "--hours runs the key's window past 9999-12-31T23:59:59Z";

export interface Assignment {
  actor: string;
  task?: string;
  change?: string;
  role?: string;
  /** How long the key holds, from now. */
  hours: number;
}

/** A key for one assignment: its private key file, and the key.issued event signed by the issuer. */
export function issueKey(
  project: string,
  assignment: Assignment,
  places: { configDir: string; keysDir: string },
  now = new Date(),
): { keyId: string; file: string; event: LedgerEvent; issuerMade: boolean; issuerId: string } {
  if (!(assignment.hours > 0)) throw new LedgerError("--hours must be a number above 0");
  if (!(now.getTime() + assignment.hours * 3600_000 <= LAST_WINDOW)) throw new LedgerError(PAST_LAST_WINDOW);
  const issuer = issuerKey(places.configDir);
  const { privateKey } = generateKeyPairSync("ed25519");
  const own = publicOf(privateKey);
  const by = publicOf(issuer.key);
  mkdirSync(places.keysDir, { recursive: true, mode: 0o700 });
  const file = join(places.keysDir, `${own.id}.pem`);
  writeKey(file, privateKey);
  const until = new Date(now.getTime() + assignment.hours * 3600_000);
  const data: Record<string, unknown> = {
    key: own.id,
    public: own.public,
    actor: assignment.actor,
    from: now.toISOString(),
    until: until.toISOString(),
    issuer: by.id,
    issuer_public: by.public,
  };
  for (const k of ["task", "change", "role"] as const) if (assignment[k] !== undefined) data[k] = assignment[k];
  const event: LedgerEvent = {
    v: 0,
    id: randomUUID(),
    time: now.toISOString(),
    type: "key.issued",
    source: { adapter: "howl-key", kind: "claimed" },
    project,
    data,
  };
  return { keyId: own.id, file, event: signEvent(event, issuer.key), issuerMade: issuer.made, issuerId: by.id };
}

/** The key.revoked event signed by the issuer; the private key file is removed. */
export function revokeKey(project: string, keyId: string, places: { configDir: string; keysDir: string }, now = new Date()): LedgerEvent {
  if (!/^[0-9a-f]{64}$/.test(keyId)) throw new LedgerError(`${keyId}: not a key id`);
  const issuer = issuerKey(places.configDir);
  rmSync(join(places.keysDir, `${keyId}.pem`), { force: true });
  const event: LedgerEvent = {
    v: 0,
    id: randomUUID(),
    time: now.toISOString(),
    type: "key.revoked",
    source: { adapter: "howl-key", kind: "claimed" },
    project,
    data: { key: keyId, at: now.toISOString(), issuer: publicOf(issuer.key).id },
  };
  return signEvent(event, issuer.key);
}

/** #202: what a pin (`--issuer`) is: the SHA-256 of the issuer's raw public key, 64 lowercase hex digits, as `howl key issue` prints it. One rule for `verify`, `up` and `serve`. */
export const PIN = /^[0-9a-f]{64}$/;
export const PIN_REFUSED = "--issuer must be a key id: 64 hex digits";

export interface SignatureFault {
  line: number;
  reason: string;
}

/** The key that signed an event, its assignment, and whether the signature holds. */
export interface SignedBy {
  key: string;
  actor: string;
  task?: string;
  change?: string;
  role?: string;
  until: string;
  ok: boolean;
  reason?: string;
}

/**
 * #212: a verdict with no assignment behind it: a key's issue or revocation, held to the issuer it names, or a
 * signed line whose key has no valid issue. `key` is the issuer a key line names, else the line's `sig.key`.
 */
export interface LineVerdict {
  key: string;
  ok: boolean;
  reason?: string;
}

/** What a reader shows of a signed line: the key's assignment when there is one (`SignedBy`), else the bare verdict. */
export type Signed = SignedBy | LineVerdict;

/**
 * #212: the one rule for the verdict of line `n`, for the event list and for a single line alike (#199, #207).
 * Undefined when the line is not signed. A key's issue or revocation is in no other list: it holds unless it has a
 * fault, and a revocation names the issuer it names, never the `sig.key` it carries. Any other line holds only when
 * the check gave it an assignment; else its first fault says why not, or the plain "the signature does not hold".
 */
export function verdictOf(check: SignatureCheck, n: number, event: LedgerEvent): Signed | undefined {
  const sig = event.sig;
  if (sig === undefined) return undefined;
  const fault = check.faults.find((f) => f.line === n);
  if (event.type === "key.issued" || event.type === "key.revoked") {
    const named = (event.data as Record<string, unknown> | undefined)?.issuer;
    const key = event.type === "key.revoked" && typeof named === "string" ? named : sig.key;
    return fault !== undefined ? { key, ok: false, reason: fault.reason } : { key, ok: true };
  }
  const held = check.byLine.get(n);
  if (held !== undefined) return held;
  return { key: sig.key, ok: false, reason: fault?.reason ?? "the signature does not hold" };
}

export interface SignatureCheck {
  signed: number;
  /** Claimed events without a signature. */
  unsigned: number;
  faults: SignatureFault[];
  /** The issuer the keys are held to: the pinned one, else the first that issued a key. */
  issuer: string | null;
  /** Whether the issuer was pinned (`howl verify --issuer`), rather than taken from the ledger. */
  pinned: boolean;
  /** Signatures by a key whose issue was refused because its issuer does not match: the pin, the ledger's issuer, or the hash of its issuer key. */
  unmatched: number;
  /** Per event id, the key that signed it and its assignment, for a reader. */
  byEvent: Map<string, SignedBy>;
  /** Per line, the key that signed it and its assignment, for a reader that shows one line (#199): a repeated id never borrows another line's verdict. */
  byLine: Map<number, SignedBy>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * #200: why a line cannot be checked, or null when it can: a field this check reads is missing or of the wrong kind.
 * Such a line is a fault of that line and is never thrown. A key's issue or revocation is not asked: it is checked as
 * it always was, whatever else the schema refuses in it, so that nothing can hide it by a field it does not know.
 */
function unreadable(event: unknown): string | null {
  if (!isObject(event)) return "the line holds no event";
  for (const field of ["id", "time", "type"]) {
    const value = event[field];
    if (typeof value !== "string" || value === "") return `${field}: ${value === undefined ? "missing" : value === "" ? "empty" : "not a text"}`;
  }
  const { source, sig } = event;
  if (source === undefined) return "source: missing";
  if (!isObject(source)) return "source: not an object";
  if (source.kind !== "observed" && source.kind !== "claimed") return `source.kind: ${source.kind === undefined ? "missing" : "not observed or claimed"}`;
  if (sig !== undefined) {
    if (!isObject(sig)) return "sig: not an object";
    if (typeof sig.key !== "string" || typeof sig.value !== "string") return "sig: key or value missing or not a text";
  }
  if (event.actor !== undefined && !isObject(event.actor)) return "actor: not an object";
  if (event.data !== undefined && !isObject(event.data)) return "data: not an object";
  return null;
}

/**
 * Checks the signatures of the ledger's events, in the order of their lines.
 * A signed event needs its key issued on an earlier line by the ledger's
 * issuer, a signature that holds, a time inside the key's window and before
 * its revocation, and the key's agent, task and change. A key's issue needs
 * an issuer key that is a key of Ed25519 and hashes to the issuer the line
 * names (#199), the issuer's signature, a public key of Ed25519, and a window
 * whose ends are ISO times with a zone. It is given every line that parses to
 * an event, also one that the readers leave out of their lists because the
 * schema refuses it (#200): a key's issue or revocation is checked as it
 * always was, whatever else is wrong with it, so that a revocation or the first
 * issuer cannot be hidden by a field the schema refuses. Any other line that
 * lacks a field this check reads, or holds it of the wrong kind, is a fault of
 * that line: it is named, has no verdict, takes no id, and changes none of
 * another line's. A line `left` out by the reader takes no id and is not held
 * to one that is taken. A revocation whose issuer's signature holds revokes the
 * key even when its id is already taken (its line is still a fault): otherwise
 * a line that took the id first would keep the key from being revoked. A
 * revocation whose sig.key is not the issuer it names is a fault on its line,
 * and still revokes (#207).
 */
export function checkSignatures(lines: { n: number; event: LedgerEvent; left?: boolean }[], pin?: string): SignatureCheck {
  const keys = new Map<string, { data: Record<string, string>; line: number; revokedAt?: number }>();
  /** The line of each event id seen (#199, after the review): a copied line is refused. */
  const ids = new Map<string, number>();
  let issuer: string | null = pin ?? null;
  let signed = 0;
  let unsigned = 0;
  let unmatched = 0;
  /** The keys whose issue was refused because its issuer does not match. */
  const unmatchedKeys = new Set<unknown>();
  const faults: SignatureFault[] = [];
  const byEvent: SignatureCheck["byEvent"] = new Map();
  const byLine: SignatureCheck["byLine"] = new Map();

  /**
   * A key.revoked's effect, and why it has none: the key must be issued, the issuer must be the ledger's and its signature must hold,
   * and the time must be readable. The earliest revocation stands. A revocation that has its effect is a fault still when its
   * sig.key is not the issuer it names (#207): the signed payload leaves out the sig, so nothing else holds it, and revoking is
   * the safe direction.
   */
  const revoke = (event: LedgerEvent, d: Record<string, string>): string | null => {
    const known = keys.get(d.key ?? "");
    const issuerPublic = known?.data.issuer_public;
    if (!known || d.issuer !== issuer || !issuerPublic || !signatureHolds(event, issuerPublic)) {
      return `revocation of key ${short(d.key)}: the issuer's signature does not hold`;
    }
    const at = d.at ?? event.time;
    const t = windowTime(at);
    if (Number.isNaN(t)) return `revocation of key ${short(d.key)}: its time cannot be read: at ${at} is not an ISO time with a zone`;
    if (known.revokedAt === undefined || t < known.revokedAt) known.revokedAt = t;
    if (event.sig?.key !== d.issuer) return `revocation of key ${short(d.key)}: the revocation is not signed by the issuer it names; the key is revoked all the same`;
    return null;
  };

  for (const { n, event, left } of lines) {
    const keyLine = isObject(event) && (event.type === "key.issued" || event.type === "key.revoked");
    const faulty = keyLine ? null : unreadable(event);
    if (faulty !== null) {
      // Left out: not counted, and its id is not taken, so that no good line is read as a copy of it.
      faults.push({ line: n, reason: `the line cannot be checked: ${faulty}` });
      continue;
    }
    // #200: a line the reader leaves out takes no id, and is not held to one that is taken.
    const seen = left ? undefined : ids.get(event.id);
    if (seen !== undefined) {
      const reason = `the event ${event.id} is already on line ${seen}`;
      faults.push({ line: n, reason });
      // #200 (second look): a revocation still revokes when its id is taken, or a line that took the id first would keep the key from being revoked.
      // Revoking is the safe direction, and its line carries the fault above.
      if (event.type === "key.revoked") revoke(event, (event.data ?? {}) as Record<string, string>);
      // No reader keyed by the id may read it as valid: a copy may differ from the line it copies.
      const first = byEvent.get(event.id);
      if (first !== undefined) {
        byEvent.set(event.id, { ...first, ok: false, reason });
        byLine.set(n, { ...first, ok: false, reason });
      }
      continue;
    }
    if (!left) ids.set(event.id, n);
    const d = (event.data ?? {}) as Record<string, string>;
    if (event.type === "key.issued" || event.type === "key.revoked") {
      // An issuer's own act: signed by the issuer it names.
      const by = event.type === "key.issued" ? d.issuer_public : undefined;
      if (event.type === "key.issued") {
        if (issuer === null) issuer = d.issuer ?? null;
        if (d.issuer !== issuer) {
          unmatchedKeys.add(d.key);
          faults.push({ line: n, reason: `key ${short(d.key)}: not issued by the ledger's issuer` });
          continue;
        }
        const weak = keyFault(by);
        if (weak !== null) {
          // A weak key that does not hash to the issuer named does not match it either.
          if (typeof by !== "string" || idOf(by) !== d.issuer) unmatchedKeys.add(d.key);
          faults.push({ line: n, reason: `key ${short(d.key)}: the issuer key is refused: ${weak}` });
          continue;
        }
        // The pin is the SHA-256 of the issuer's raw public key, in hex, as `howl key issue` prints it.
        if (idOf(by!) !== d.issuer) {
          unmatchedKeys.add(d.key);
          faults.push({ line: n, reason: `key ${short(d.key)}: the issuer key does not hash to the issuer it names` });
          continue;
        }
        if (!signatureHolds(event, by!) || event.sig?.key !== d.issuer) {
          faults.push({ line: n, reason: `key ${short(d.key)}: the issuer's signature does not hold` });
          continue;
        }
        const own = keyFault(d.public);
        if (own !== null) {
          faults.push({ line: n, reason: `key ${short(d.key)}: its public key is refused: ${own}` });
          continue;
        }
        // The key's id is the SHA-256 of its raw public key, as `issueKey` makes it.
        if (idOf(d.public!) !== d.key) {
          faults.push({ line: n, reason: `key ${short(d.key)}: its public key does not hash to its id` });
          continue;
        }
        const end = (["from", "until"] as const).find((e) => Number.isNaN(windowTime(d[e])));
        if (end !== undefined) {
          faults.push({ line: n, reason: `key ${short(d.key)}: its window cannot be read: ${end} ${d[end]} is not an ISO time with a zone` });
          continue;
        }
        // A key keeps its first issue and its revocation.
        const first = keys.get(d.key!);
        if (first !== undefined) {
          faults.push({ line: n, reason: `key ${short(d.key)}: the key is already issued on line ${first.line}` });
          continue;
        }
        keys.set(d.key!, { data: d, line: n });
      } else {
        const refused = revoke(event, d);
        if (refused !== null) faults.push({ line: n, reason: refused });
      }
      continue;
    }

    if (!event.sig) {
      if (event.source.kind === "claimed") unsigned++;
      continue;
    }
    signed++;
    const key = keys.get(event.sig.key);
    const fail = (reason: string) => {
      faults.push({ line: n, reason });
      if (key) {
        byEvent.set(event.id, { ...info(key.data), ok: false, reason });
        byLine.set(n, { ...info(key.data), ok: false, reason });
      }
    };
    if (!key) {
      if (unmatchedKeys.has(event.sig.key)) unmatched++;
      fail(`signed by key ${short(event.sig.key)}, which has no valid issue on a line before`);
      continue;
    }
    const d2 = key.data;
    if (!signatureHolds(event, d2.public!)) {
      fail("the signature does not hold: the event was changed after it was signed");
      continue;
    }
    const t = Date.parse(event.time);
    if (t < Date.parse(d2.from!) || t > Date.parse(d2.until!)) {
      fail(`signed outside the key's window (${d2.from} to ${d2.until})`);
      continue;
    }
    if (key.revokedAt !== undefined && t > key.revokedAt) {
      fail("signed after the key was revoked");
      continue;
    }
    if (event.actor?.id !== d2.actor) {
      fail(`${event.actor?.id ?? "no one"} is not the key's agent (${d2.actor})`);
      continue;
    }
    if (d2.change !== undefined && event.change !== undefined && event.change !== d2.change) {
      fail(`change ${event.change} is not the key's change (${d2.change})`);
      continue;
    }
    if (d2.task !== undefined && event.task !== undefined && event.task !== d2.task) {
      fail(`task ${event.task} is not the key's task (${d2.task})`);
      continue;
    }
    byEvent.set(event.id, { ...info(d2), ok: true });
    byLine.set(n, { ...info(d2), ok: true });
  }
  return { signed, unsigned, faults, issuer, pinned: pin !== undefined, unmatched, byEvent, byLine };
}

function info(d: Record<string, string>) {
  return { key: d.key!, actor: d.actor!, task: d.task, change: d.change, role: d.role, until: d.until! };
}

const short = (id: unknown) => (typeof id === "string" ? id : "?").slice(0, 12);
