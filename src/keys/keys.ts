// Signed claims with a key per assignment (#23). The issuer key of a project
// issues an Ed25519 key for one assignment (agent, task, change, role, window);
// the session's hook signs its events with it; the check finds every signed
// event's key in the ledger and holds it to what was issued.
//
// Said plainly: on one machine with one user, that user can read an agent's key.
// Signing binds every claim to an issued assignment, makes a later change show
// and bounds misuse to the key's window; keeping keys out of the user's reach is
// a step of its own.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LedgerError } from "../ledger/errors.ts";
import { fixedForm } from "../ledger/fixed.ts";
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

export interface SignatureFault {
  line: number;
  reason: string;
}

export interface SignatureCheck {
  signed: number;
  /** Claimed events without a signature. */
  unsigned: number;
  faults: SignatureFault[];
  /** The issuer the keys are held to: the pinned one, else the first that issued a key. */
  issuer: string | null;
  /** Per event id, the key that signed it and its assignment, for a reader. */
  byEvent: Map<string, { key: string; actor: string; task?: string; change?: string; role?: string; until: string; ok: boolean; reason?: string }>;
}

/**
 * Checks the signatures of the ledger's events, in the order of their lines.
 * A signed event needs its key issued on an earlier line by the ledger's
 * issuer, a signature that holds, a time inside the key's window and before
 * its revocation, and the key's agent, task and change.
 */
export function checkSignatures(lines: { n: number; event: LedgerEvent }[], pin?: string): SignatureCheck {
  const keys = new Map<string, { data: Record<string, string>; revokedAt?: number }>();
  let issuer: string | null = pin ?? null;
  let signed = 0;
  let unsigned = 0;
  const faults: SignatureFault[] = [];
  const byEvent: SignatureCheck["byEvent"] = new Map();

  for (const { n, event } of lines) {
    const d = (event.data ?? {}) as Record<string, string>;
    if (event.type === "key.issued" || event.type === "key.revoked") {
      // An issuer's own act: signed by the issuer it names.
      const by = event.type === "key.issued" ? d.issuer_public : undefined;
      if (event.type === "key.issued") {
        if (issuer === null) issuer = d.issuer ?? null;
        if (d.issuer !== issuer) {
          faults.push({ line: n, reason: `key ${short(d.key)}: not issued by the ledger's issuer` });
          continue;
        }
        if (!by || !signatureHolds(event, by) || event.sig?.key !== d.issuer) {
          faults.push({ line: n, reason: `key ${short(d.key)}: the issuer's signature does not hold` });
          continue;
        }
        keys.set(d.key!, { data: d });
      } else {
        const known = keys.get(d.key ?? "");
        const issuerPublic = known?.data.issuer_public;
        if (!known || d.issuer !== issuer || !issuerPublic || !signatureHolds(event, issuerPublic)) {
          faults.push({ line: n, reason: `revocation of key ${short(d.key)}: the issuer's signature does not hold` });
          continue;
        }
        known.revokedAt = Date.parse(d.at ?? event.time);
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
      if (key) byEvent.set(event.id, { ...info(key.data), ok: false, reason });
    };
    if (!key) {
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
  }
  return { signed, unsigned, faults, issuer, byEvent };
}

function info(d: Record<string, string>) {
  return { key: d.key!, actor: d.actor!, task: d.task, change: d.change, role: d.role, until: d.until! };
}

const short = (id: string | undefined) => (id ?? "?").slice(0, 12);
