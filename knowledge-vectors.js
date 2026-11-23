// Knowledge vectors (off by default): one vectors table over every Knowledge store
// and partition, embedded with Harrier, offered to Knowledge's owner search as
// ids and scores only. Knowledge validates every proposal and shows only its own
// text. Ported from the k1k2 add-on (Design A spike). No OpenClaw imports here:
// embedding is injected.
//
// Known debt, carried from Design A: records are read from Knowledge's
// documented on-disk layout (docs/plugins/knowledge/stores-and-access.md),
// read-only, because no SDK surface lists them.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const now = () => performance.now();
export const ms = (a, b) => Math.round((b - a) * 10) / 10;
export const sha = (s) => createHash("sha256").update(s).digest("hex");

// ---------- minimal frontmatter reader (no YAML dependency) ----------
// YAML double-quoted escapes beyond JSON's.
const YAML_ESCAPES = { 0: "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b", " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\x85", _: "\xa0", L: "\u2028", P: "\u2029" };
function unescapeDoubleQuoted(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[\s\S])/g, (m, e) =>
    e.length > 1 ? String.fromCodePoint(parseInt(e.slice(1), 16)) : (YAML_ESCAPES[e] ?? e),
  );
}
function unquote(v) {
  v = v.trim();
  if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) return unescapeDoubleQuoted(v.slice(1, -1));
  if (v.length > 1 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}
// Where a quoted scalar starting at v[0] closes, or -1 while it is still open.
function closingQuote(v) {
  const q = v[0];
  for (let i = 1; i < v.length; i++) {
    if (q === '"' && v[i] === "\\") i++;
    else if (v[i] === q) {
      if (q === "'" && v[i + 1] === "'") i++;
      else return i;
    }
  }
  return -1;
}
const ENTRY = /^(\s*(?:[A-Za-z_][\w-]*:|-)(?:\s+|$))(.*)$/;
const BLOCK = /^([|>])(?:([1-9])([-+]?)|([-+]?)([1-9]?))$/;
// A double-quoted line loses its surrounding whitespace, except a space or tab escaped with `\`.
function trimDoubleQuoted(line) {
  const s = line.trimStart();
  const m = /[ \t]+$/.exec(s);
  if (!m) return s;
  const before = s.slice(0, m.index);
  return /(^|[^\\])(\\\\)*\\$/.test(before) ? before + s[m.index] : before;
}
// Folded lines as YAML reads them: a line break is a space, an empty line a newline, and in
// double quotes a trailing `\` joins with nothing.
function fold(pieces, quote) {
  let v = pieces[0] ?? "";
  for (let i = 1; i < pieces.length; i++) {
    const piece = pieces[i];
    const escapedBreak = quote === '"' && /(^|[^\\])(\\\\)*\\$/.test(v);
    if (piece === "") v = (escapedBreak ? v.slice(0, -1) : v) + "\n";
    else if (escapedBreak) v = v.slice(0, -1) + piece;
    else v += (v.endsWith("\n") || v === "" ? "" : " ") + piece;
  }
  return v;
}
// A folded block scalar: as fold(), except that line breaks next to a more-indented line stay.
function foldBlock(lines) {
  let v = "", prev = null, blanks = 0;
  for (const l of lines) {
    if (l === "") {
      blanks++;
      continue;
    }
    if (prev === null) v += "\n".repeat(blanks);
    else if (/^[ \t]/.test(prev) || /^[ \t]/.test(l)) v += "\n".repeat(blanks + 1);
    else v += blanks ? "\n".repeat(blanks) : " ";
    v += l;
    prev = l;
    blanks = 0;
  }
  return v;
}
/**
 * Knowledge writes frontmatter with the yaml library at its default 80-column width, which
 * folds a long value onto more-indented continuation lines (a quoted one until its closing
 * quote), and writes a value with line breaks as a block scalar. Joins each back onto one
 * line; a block scalar becomes a double-quoted value.
 */
function unfoldFrontmatter(lines) {
  const out = [];
  let cur = null; // { head, pieces, indent, quote, open, block }
  const flush = () => {
    if (!cur) return;
    const { pieces } = cur;
    let trailing = 0;
    while (pieces.length > (cur.block ? 0 : 1) && pieces.at(-1).trim() === "") pieces.pop(), trailing++;
    if (cur.block) {
      const [, style, i1, c1, c2, i2] = BLOCK.exec(cur.block);
      const chomp = c1 || c2, explicit = Number(i1 || i2);
      // An indentation indicator counts from the entry's own indent; otherwise the first line sets it.
      const first = pieces.find((l) => l.trim());
      const strip = explicit ? cur.indent + explicit : first ? first.length - first.trimStart().length : 0;
      const body = pieces.map((l) => l.slice(strip));
      let v = style === "|" ? body.join("\n") : foldBlock(body);
      if (chomp === "+") v += "\n".repeat(v ? trailing + 1 : trailing);
      else if (v && chomp !== "-") v += "\n";
      out.push(cur.head + JSON.stringify(v));
    } else out.push(cur.head + fold(pieces, cur.quote));
    cur = null;
  };
  for (const line of lines) {
    const indent = line.length - line.trimStart().length;
    if (cur && (cur.open || (cur.quote === null && (line.trim() === "" || indent > cur.indent)))) {
      const piece = cur.block ? line : cur.quote === '"' ? trimDoubleQuoted(line) : line.trim();
      cur.pieces.push(piece);
      if (cur.open && piece && closingQuote(cur.quote + piece) !== -1) cur.open = false;
      continue;
    }
    flush();
    const m = ENTRY.exec(line);
    const v = m ? (m[2][0] === '"' ? trimDoubleQuoted(m[2]) : m[2].trimEnd()) : "";
    // A nested block (no value) is left as it is; its own entries fold.
    if (!m || !v) {
      out.push(line);
      continue;
    }
    if (BLOCK.test(v)) {
      cur = { head: m[1], pieces: [], indent, quote: null, open: false, block: v };
      continue;
    }
    const quote = v[0] === '"' || v[0] === "'" ? v[0] : null;
    cur = { head: m[1], pieces: [v], indent, quote, open: quote !== null && closingQuote(v) === -1 };
  }
  flush();
  return out;
}

// Knowledge's own frontmatter match (storage-publication.ts), on LF-normalized text: it
// accepts a BOM, CRLF line endings and a closing marker at the end of the file.
const FRONTMATTER = /^(?:\uFEFF)?---\n([\s\S]*?)\n---(?:\n|$)/;

export function parseRecord(raw) {
  const text = raw.replace(/\r\n?/g, "\n");
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  const fm = unfoldFrontmatter(match[1].split("\n"));
  const body = text.slice(match[0].length);
  const top = {};
  const scope = {};
  let section = null;
  const lists = {};
  for (const line of fm) {
    // A joined value may hold a line break.
    let m = /^([A-Za-z_][\w-]*):(?:\s([\s\S]*))?$/.exec(line);
    if (m) {
      section = m[1];
      const v = (m[2] ?? "").trim();
      if (v) {
        if (v.startsWith("[") && v.endsWith("]")) {
          lists[section] = v.slice(1, -1).split(",").map((x) => unquote(x)).filter(Boolean);
        } else top[section] = unquote(v);
      }
      continue;
    }
    m = /^\s+([A-Za-z_][\w-]*):\s([\s\S]*)$/.exec(line);
    if (m && section === "scope") scope[m[1]] = unquote(m[2]);
    m = /^\s+-\s([\s\S]*)$/.exec(line);
    if (m && section && !top[section]) (lists[section] ??= []).push(unquote(m[1]));
  }
  if (top.format !== "knowledge-record-v1" || !top.id) return null;
  // Knowledge always writes an integer revision from 1; anything else is unknown (null).
  const revision = /^[1-9]\d*$/.test(top.revision ?? "") ? Number(top.revision) : null;
  return {
    id: String(top.id),
    revision,
    kind: top.kind,
    title: top.title ?? "",
    lifecycle: top.lifecycle ?? "active",
    supersededBy: top.superseded_by,
    supersedes: top.supersedes,
    aliases: lists.aliases ?? [],
    attribution: typeof top.attribution === "string" ? top.attribution : undefined,
    scope,
    body,
    hash: sha(raw),
  };
}

// Only a path that is not there is gone; EACCES, EMFILE and the rest are unreadable for now.
const isMissing = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";

function walk(dir, out, unreadable) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (!isMissing(e)) unreadable(dir, e);
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "artifacts" || e.name.startsWith(".")) continue;
      walk(p, out, unreadable);
    } else if (e.isFile() && e.name.endsWith(".md")) out.push(p);
  }
  return out;
}

/**
 * Documented layout (docs/plugins/knowledge/stores-and-access.md "Storage layout"), read-only.
 * A directory or record that exists but cannot be read goes to onUnreadable({ vaultId, rel,
 * error }) with its path relative to the vault, so the caller can keep what it had there.
 * An unreadable stores root or vault.json throws: nothing could be told apart.
 */
export function enumerateRecords(stateDir, { onUnreadable = () => {} } = {}) {
  const root = path.join(stateDir, "knowledge", "stores");
  const out = [];
  let stores = [];
  try {
    stores = fs.readdirSync(root);
  } catch (e) {
    if (isMissing(e)) return out;
    throw e;
  }
  for (const s of stores) {
    const vault = path.join(root, s, "vault");
    let vaultId = s;
    try {
      vaultId = JSON.parse(fs.readFileSync(path.join(vault, "vault.json"), "utf8")).vaultId ?? s;
    } catch (e) {
      // Missing or not JSON: the directory name. Unreadable: the real id is unknown.
      if (e?.code && !isMissing(e)) throw e;
    }
    const unreadable = (p, error) => onUnreadable({ vaultId, rel: path.relative(vault, p), error });
    const parts = [["private", path.join(vault, "private")]];
    try {
      for (const sid of fs.readdirSync(path.join(vault, "conversations")))
        parts.push([`conversation:${sid}`, path.join(vault, "conversations", sid)]);
    } catch (e) {
      if (!isMissing(e)) unreadable(path.join(vault, "conversations"), e);
    }
    for (const [partition, dir] of parts) {
      for (const file of walk(dir, [], unreadable)) {
        let raw;
        try {
          raw = fs.readFileSync(file, "utf8");
        } catch (e) {
          if (!isMissing(e)) unreadable(file, e);
          continue;
        }
        const r = parseRecord(raw);
        if (r) out.push({ ...r, vaultId, partition, path: path.relative(vault, file) });
      }
    }
  }
  return out;
}

/**
 * Estimated tokens per embedded chunk. OpenClaw's managed llama.cpp preset gives the embedding
 * model a 2,048-token context, and a longer input fails on every attempt; the rest is headroom
 * for special tokens and the estimate.
 */
export const CHUNK_TOKENS = 1800;
/** Estimated tokens the next chunk repeats from the end of the one before. */
export const CHUNK_OVERLAP_TOKENS = 100;
/** The header (context, title, aliases) every chunk starts with is cut to this. */
const HEADER_TOKENS = 400;
// An upper estimate of the tokens one character costs Harrier's byte-level BPE (Qwen3):
// at most one per UTF-8 byte, which bounds CJK and other non-ASCII text, digits,
// punctuation and spaces. Runs of ASCII letters merge into far fewer tokens.
const tokenCost = (ch) => {
  const c = ch.codePointAt(0);
  if (c < 0x80) return (c | 0x20) >= 0x61 && (c | 0x20) <= 0x7a ? 0.6 : 1;
  return c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};
export const estimateTokens = (text) => {
  let n = 0;
  for (const ch of text) n += tokenCost(ch);
  return n;
};
/** The longest prefix of `text` (whole code points) within `budget` estimated tokens. */
function truncateToTokens(text, budget) {
  let used = 0, end = 0;
  for (const ch of text) {
    used += tokenCost(ch);
    if (used > budget) return text.slice(0, end);
    end += ch.length;
  }
  return text;
}
// Where to end a chunk: after the last paragraph break, line break, sentence end or space in
// its last third, else exactly at the budget (CJK runs have no spaces).
const BREAKS = [
  (cps, i) => cps[i] === "\n" && cps[i - 1] === "\n",
  (cps, i) => cps[i] === "\n",
  (cps, i) => /[.!?。！？]/u.test(cps[i]),
  (cps, i) => /\s/u.test(cps[i]),
];
const isBreak = (cps, i) => BREAKS.some((b) => b(cps, i));
/** Splits `text` into pieces of at most `budget` estimated tokens, overlapping by about `overlap`. */
function splitByTokens(text, budget, overlap) {
  const cps = [...text];
  const cum = [0];
  for (const ch of cps) cum.push(cum.at(-1) + tokenCost(ch));
  const pieces = [];
  let start = 0;
  while (start < cps.length) {
    let end = start;
    while (end < cps.length && cum[end + 1] - cum[start] <= budget) end++;
    if (end === start) end = start + 1;
    if (end < cps.length) {
      const from = start + Math.ceil(((end - start) * 2) / 3);
      for (const b of BREAKS) {
        let at = -1;
        for (let i = end - 1; i >= from; i--) {
          if (b(cps, i)) {
            at = i + 1;
            break;
          }
        }
        if (at > start) {
          end = at;
          break;
        }
      }
    }
    pieces.push(cps.slice(start, end).join("").trim());
    if (end >= cps.length) break;
    // Step back about `overlap` tokens, then on to the next sentence or word, always moving forward.
    let next = end;
    while (next > start + 1 && cum[end] - cum[next - 1] <= overlap) next--;
    for (let i = next; i < end - 1; i++) {
      if (isBreak(cps, i)) {
        next = i + 1;
        break;
      }
    }
    start = next;
  }
  return pieces.filter(Boolean);
}

/**
 * The texts embedded for a record, in order: one when it fits a chunk (exactly the text
 * earlier versions embedded, so their embed cache still hits), else the body split into
 * overlapping chunks, each led by the record's header.
 */
export function embedChunks(r, settings = {}) {
  // Experiment (spike): settings.contextField === "attribution" prepends the source/section line, so
  // claims split out of a section keep their topic ("Root cause: ..." -> which booking?).
  const ctx =
    settings.contextField === "attribution" && r.attribution
      ? `Context: ${r.attribution.replace(/\s*\(copy imported for Design A spike.*$/u, "").slice(0, 300)}`
      : "";
  const header = truncateToTokens(
    [ctx, r.title, r.aliases.length ? `Also known as: ${r.aliases.join(", ")}` : ""].filter(Boolean).join("\n"),
    HEADER_TOKENS,
  );
  const whole = [header, r.body].filter(Boolean).join("\n");
  if (estimateTokens(whole) <= CHUNK_TOKENS) return [whole];
  const room = CHUNK_TOKENS - (header ? estimateTokens(header) + 1 : 0);
  return splitByTokens(r.body, room, CHUNK_OVERLAP_TOKENS).map((piece) => (header ? `${header}\n${piece}` : piece));
}

const f32 = (v) => Buffer.from(new Float32Array(v).buffer);
const unf32 = (b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
export function cosine(a, b) {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return d / (Math.sqrt(na * nb) || 1);
}
/**
 * The store's ordered migration history (append only). Each step and its history
 * row commit in one transaction, so a failed step leaves the prior version usable
 * and a committed step never runs again. Supported predecessor: the unversioned
 * Design A spike layout, which step 1 adopts in place (same tables and columns).
 */
export const MIGRATIONS = [
  {
    version: 1,
    description: "vectors, embed_cache, events and tombstones; adopts the unversioned spike layout",
    up: (db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS vectors (vault_id TEXT, partition TEXT, id TEXT, revision INTEGER, hash TEXT,
      lifecycle TEXT, kind TEXT, title TEXT, path TEXT, text_hash TEXT, vec BLOB, indexed_at INTEGER,
      PRIMARY KEY (vault_id, partition, id));
    CREATE TABLE IF NOT EXISTS embed_cache (text_hash TEXT PRIMARY KEY, vec BLOB);
    CREATE TABLE IF NOT EXISTS events (at INTEGER, kind TEXT, id TEXT, detail TEXT);
    CREATE TABLE IF NOT EXISTS tombstones (vault_id TEXT, partition TEXT, id TEXT, revision INTEGER, lifecycle TEXT,
      PRIMARY KEY (vault_id, partition, id));`),
  },
  {
    version: 2,
    description: "one vectors row per chunk of a record; every record is looked at again once",
    // A NULL file hash makes the next pass take up every record once: text that is unchanged
    // hits the embed cache, and a record that used to be cut short is embedded in chunks.
    up: (db) =>
      db.exec(`CREATE TABLE vectors_v2 (vault_id TEXT, partition TEXT, id TEXT, chunk INTEGER NOT NULL, revision INTEGER,
      hash TEXT, lifecycle TEXT, kind TEXT, title TEXT, path TEXT, text_hash TEXT, vec BLOB, indexed_at INTEGER,
      PRIMARY KEY (vault_id, partition, id, chunk));
    INSERT INTO vectors_v2 SELECT vault_id, partition, id, 0, revision, NULL, lifecycle, kind, title, path, text_hash, vec, indexed_at
      FROM vectors;
    DROP TABLE vectors;
    ALTER TABLE vectors_v2 RENAME TO vectors;`),
  },
];

/** Bring the store to the latest schema, or refuse a newer one without changing it. */
export function migrate(db, steps = MIGRATIONS) {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)",
  );
  const current = db.prepare("SELECT max(version) AS v FROM schema_migrations").get().v ?? 0;
  const latest = steps.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(
      `knowledge-vectors.sqlite is at schema ${current}, newer than this knowledge-embeddings plugin supports (${latest}). Upgrade knowledge-embeddings or restore the backup that matches it; the store was not changed.`,
    );
  }
  for (const step of steps) {
    if (step.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      step.up(db);
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(
        step.version,
        step.description,
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return latest;
}

/** Newest rows kept in the events table. */
export const EVENTS_KEEP = 10_000;
/** Records failing alone in a row before a probe embed checks that the embedder is up. */
const FAIL_STREAK_PROBE = 3;
/** The probe: short enough that only a down embedder fails it. */
const PROBE_TEXT = "knowledge-embeddings probe";

/**
 * The vector side: own SQLite file, content-addressed embed cache, indexer and vector leg.
 * `embedDocs(texts)` / `embedQuery(text)` are injected.
 */
export function createVectorIndex({ dbPath, stateDir, embedDocs, embedQuery, settings }) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  const eventsKeep = settings.eventsKeep ?? EVENTS_KEEP;
  const pruneEvents = () =>
    db.prepare("DELETE FROM events WHERE rowid <= (SELECT max(rowid) FROM events) - ?").run(eventsKeep);
  // A refused (newer) or broken store must not keep its file handles open for every retry.
  try {
    db.exec("PRAGMA journal_mode=WAL");
    migrate(db);
    pruneEvents();
  } catch (e) {
    db.close();
    throw e;
  }
  const logEvent = (kind, id, detail) =>
    db.prepare("INSERT INTO events VALUES (?,?,?,?)").run(Date.now(), kind, id ?? null, detail ? JSON.stringify(detail) : null);
  const state = { queryInFlight: 0 };
  const qcache = new Map();
  // Set by close(): passes stop at the next batch, searches answer empty, the DB closes once.
  let closing = false;
  async function queryVector(q, useCache = true) {
    if (useCache && qcache.has(q)) return { vec: qcache.get(q), cached: true };
    state.queryInFlight++;
    try {
      const v = await embedQuery(q);
      qcache.set(q, v);
      if (qcache.size > 500) qcache.delete(qcache.keys().next().value);
      return { vec: v, cached: false };
    } finally {
      state.queryInFlight--;
    }
  }

  // Logged once while the index is open, so a pass that changes nothing writes nothing.
  const blockedLogged = new Set();
  const failedLogged = new Set();
  // Text hashes that failed to embed; they go last in the next pass.
  const failedHashes = new Set();
  let indexing = null;
  async function reindex({ indexInactive = settings.indexInactive, batchSize = settings.batchSize } = {}) {
    if (indexing) return indexing;
    if (closing) return null;
    indexing = (async () => {
      const t0 = now();
      // What could not be read this pass keeps its rows: a permission or fd error is not a deletion.
      const unreadable = [];
      const recs = enumerateRecords(stateDir, { onUnreadable: (u) => unreadable.push(u) });
      const kept = (row) =>
        unreadable.some((u) => row.vault_id === u.vaultId && (row.path === u.rel || row.path?.startsWith(u.rel + path.sep)));
      // embedded, cacheHits and failed count chunks; the rest count records.
      const stats = { scanned: recs.length, chunks: 0, embedded: 0, cacheHits: 0, inserted: 0, replaced: 0, refreshed: 0, dropped: 0, unchanged: 0, removedMissing: 0, unreadable: unreadable.length, failed: 0, batches: 0, embedMs: 0 };
      let logged = 0;
      const note = (kind, id, detail) => (logged++, logEvent(kind, id, detail));
      const seen = new Set();
      const pending = [];
      // A record's rows, one per chunk, all with the same record fields.
      const getRows = db.prepare("SELECT chunk, revision, hash, text_hash FROM vectors WHERE vault_id=? AND partition=? AND id=? ORDER BY chunk");
      const getRow = (...key) => {
        const rows = getRows.all(...key);
        return rows.length ? { revision: rows[0].revision, hash: rows[0].hash, texts: rows.map((x) => `${x.chunk}:${x.text_hash}`).join(",") } : undefined;
      };
      const del = db.prepare("DELETE FROM vectors WHERE vault_id=? AND partition=? AND id=?");
      const tomb = db.prepare("SELECT revision, lifecycle FROM tombstones WHERE vault_id=? AND partition=? AND id=?");
      const putTomb = db.prepare("INSERT OR REPLACE INTO tombstones VALUES (?,?,?,?,?)");
      stats.staleRestoreBlocked = 0;
      const blockedNow = new Set();
      for (const r of recs) {
        const key = `${r.vaultId}\u0000${r.partition}\u0000${r.id}`;
        seen.add(key);
        const row = getRow(r.vaultId, r.partition, r.id);
        // Sticky tombstones: once an id was seen withdrawn/superseded at revision N, an "active"
        // file at revision <= N is a stale or restored copy (Knowledge revisions only grow).
        // An unknown (null) revision is never newer than a tombstone, and any known one is
        // newer than a tombstone of unknown revision.
        const tb = tomb.get(r.vaultId, r.partition, r.id);
        if (r.lifecycle !== "active") {
          if (!tb || tb.revision === null || tb.revision < r.revision) putTomb.run(r.vaultId, r.partition, r.id, r.revision, r.lifecycle);
        } else if (tb && settings.stickyTombstones !== false) {
          if (r.revision === null || (tb.revision !== null && r.revision <= tb.revision)) {
            if (row) del.run(r.vaultId, r.partition, r.id);
            stats.staleRestoreBlocked++;
            const blocked = `${key}\u0000${r.revision}\u0000${tb.revision}`;
            blockedNow.add(blocked);
            if (row || !blockedLogged.has(blocked)) {
              note("stale-restore-blocked", r.id, { fileRevision: r.revision, tombstoneRevision: tb.revision, tombstoneLifecycle: tb.lifecycle });
            }
            continue;
          }
          db.prepare("DELETE FROM tombstones WHERE vault_id=? AND partition=? AND id=?").run(r.vaultId, r.partition, r.id);
        }
        if (r.lifecycle !== "active" && !indexInactive) {
          if (row) {
            del.run(r.vaultId, r.partition, r.id);
            stats.dropped++;
            note("drop", r.id, { lifecycle: r.lifecycle, supersededBy: r.supersededBy, oldRevision: row.revision, newRevision: r.revision });
          }
          continue;
        }
        // The hash covers the whole file, revision included (a missing revision is stored as NULL).
        if (row && row.hash === r.hash) {
          stats.unchanged++;
          continue;
        }
        pending.push({ r, row });
      }
      blockedLogged.clear();
      for (const b of blockedNow) blockedLogged.add(b);
      for (const row of db.prepare("SELECT DISTINCT vault_id, partition, id, path FROM vectors").all()) {
        if (!seen.has(`${row.vault_id}\u0000${row.partition}\u0000${row.id}`) && !kept(row)) {
          del.run(row.vault_id, row.partition, row.id);
          stats.removedMissing++;
          note("drop-missing", row.id, null);
        }
      }
      const upsert = db.prepare("INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)");
      const cacheGet = db.prepare("SELECT vec FROM embed_cache WHERE text_hash=?");
      const cachePut = db.prepare("INSERT OR REPLACE INTO embed_cache VALUES (?,?)");
      // A record is written, all its chunks in one transaction, as soon as each chunk has
      // embedded or failed, not at the end of the pass. Chunks that failed are left out, and
      // without the file hash, so the next pass takes the record up again and retries them.
      const finish = (p) => {
        const done = p.chunks.filter((c) => c.vec);
        // Nothing embedded: whatever was stored stays until the next pass.
        if (!done.length) return;
        const r = p.r;
        const hash = done.length === p.chunks.length ? r.hash : null;
        const texts = done.map((c) => `${c.index}:${c.textHash}`).join(",");
        db.exec("BEGIN");
        try {
          del.run(r.vaultId, r.partition, r.id);
          const at = Date.now();
          for (const c of done) {
            upsert.run(r.vaultId, r.partition, r.id, c.index, r.revision, hash, r.lifecycle, r.kind ?? null, r.title, r.path, c.textHash, c.vec, at);
          }
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        if (!p.row) stats.inserted++;
        // Taken up again only because the hash was unknown (migrated, or chunks failed before),
        // with the same text: nothing to report.
        else if (p.row.hash === null && p.row.texts === texts) stats.refreshed++;
        else {
          stats.replaced++;
          note("replace", r.id, { oldRevision: p.row.revision, newRevision: r.revision, reembedded: p.row.texts !== texts, chunks: p.chunks.length });
        }
      };
      const resolved = (c) => {
        if (--c.rec.left === 0) finish(c.rec);
      };
      // Failures since the last embed that worked: each is the chunk's own fault (it will
      // never embed) only once the embedder is known to be up.
      let suspects = [];
      const failures = [];
      const confirm = () => {
        failures.push(...suspects);
        suspects = [];
      };
      const embedded = (c, v) => {
        c.vec = f32(v);
        cachePut.run(c.textHash, c.vec);
        stats.embedded++;
        failedHashes.delete(c.textHash);
        failedLogged.delete(c.textHash);
        confirm();
        resolved(c);
      };
      // A chunk that will not embed is skipped and retried next pass. After a few in a row,
      // one probe embed tells a down embedder (abort the pass) from chunks it rejects (go on).
      const probe = async () => {
        while (state.queryInFlight > 0 && !closing) await new Promise((r) => setTimeout(r, 5));
        if (closing) return;
        try {
          await embedDocs([PROBE_TEXT]);
        } catch (e) {
          if (closing) return;
          throw e;
        }
        confirm();
      };
      const failed = async (c, e) => {
        stats.failed++;
        failedHashes.add(c.textHash);
        suspects.push([c, e]);
        resolved(c);
        if (suspects.length >= FAIL_STREAK_PROBE) await probe();
      };
      const toEmbed = [];
      for (const p of pending) {
        const texts = embedChunks(p.r, settings);
        p.left = texts.length;
        p.chunks = texts.map((text, index) => ({ rec: p, index, text, textHash: sha(text) }));
        stats.chunks += texts.length;
        for (const c of p.chunks) {
          const hit = cacheGet.get(c.textHash);
          if (hit) {
            c.vec = hit.vec;
            stats.cacheHits++;
            resolved(c);
          } else toEmbed.push(c);
        }
      }
      // Chunks that failed before go last, so they cannot hold back new ones.
      toEmbed.sort((a, b) => failedHashes.has(a.textHash) - failedHashes.has(b.textHash));
      let aborted;
      try {
        for (let i = 0; i < toEmbed.length && !closing; i += batchSize) {
          // Finding 4: never hold the single llama.cpp slot while a query embed waits.
          while (state.queryInFlight > 0 && !closing) await new Promise((r) => setTimeout(r, 5));
          if (closing) break;
          const batch = toEmbed.slice(i, i + batchSize);
          const tb = now();
          let vecs, error;
          try {
            vecs = await embedDocs(batch.map((b) => b.text));
          } catch (e) {
            error = e;
          }
          stats.embedMs += now() - tb;
          stats.batches++;
          if (vecs) batch.forEach((b, j) => embedded(b, vecs[j]));
          else if (closing) break;
          else if (batch.length === 1) await failed(batch[0], error);
          else {
            // Isolate the record that fails: retry the batch one record at a time.
            for (const b of batch) {
              if (closing) break;
              let v;
              try {
                [v] = await embedDocs([b.text]);
              } catch (e) {
                if (closing) break;
                await failed(b, e);
                continue;
              }
              embedded(b, v);
            }
          }
          await new Promise((r) => setImmediate(r));
        }
        // The last few failures, too, count against a record only if the embedder is up.
        if (suspects.length && !closing) await probe();
      } catch (e) {
        aborted = e;
      }
      stats.embedMs = Math.round(stats.embedMs);
      stats.ms = ms(t0, now());
      if (closing) {
        stats.cancelled = true;
        return stats;
      }
      // An aborted pass still records what it learnt and prunes; the abort error wins.
      try {
        for (const [c, e] of failures) {
          if (failedLogged.has(c.textHash)) continue;
          failedLogged.add(c.textHash);
          note("embed-failed", c.rec.r.id, { chunk: c.index, chunks: c.rec.chunks.length, error: String(e?.message ?? e) });
        }
        if (aborted) stats.aborted = String(aborted?.message ?? aborted);
        const changed = stats.embedded + stats.inserted + stats.replaced + stats.dropped + stats.removedMissing;
        if (changed > 0 || logged > 0) {
          logEvent("reindex", null, stats);
          pruneEvents();
        }
      } catch (e) {
        if (!aborted) throw e;
      }
      if (aborted) throw aborted;
      return stats;
    })().finally(() => {
      indexing = null;
    });
    return indexing;
  }

  // One query embed, then one scan over every stored row: no per-store or per-partition work.
  // Knowledge decides which stores and partitions a caller may see.
  async function vectorCandidates(query, { topK, floor, useCache = true }) {
    const empty = { cands: [], embedMs: 0, rankMs: 0, cached: false, rows: 0 };
    if (closing) return empty;
    const t0 = now();
    const { vec, cached } = await queryVector(query, useCache);
    // close() may have run during the embed; nothing below awaits, so this check holds.
    if (closing) return empty;
    const t1 = now();
    const q = Float32Array.from(vec);
    const rows = db.prepare("SELECT vault_id, partition, id, chunk, revision, title, lifecycle, vec FROM vectors").all();
    const scored = rows
      .map((r) => ({ id: r.id, vaultId: r.vault_id, partition: r.partition, chunk: r.chunk, revision: r.revision, title: r.title, lifecycle: r.lifecycle, cos: cosine(q, unf32(r.vec)) }))
      .filter((r) => r.cos >= floor)
      .sort((a, b) => b.cos - a.cos);
    const out = [];
    const seen = new Set();
    for (const r of scored) {
      // A record scores as its best chunk and is proposed once. The same id may live in
      // several stores or partitions; Knowledge gates each one.
      const key = `${r.vaultId}\u0000${r.partition}\u0000${r.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(r);
      if (out.length >= topK) break;
    }
    return { cands: out, embedMs: ms(t0, t1), rankMs: ms(t1, now()), cached, rows: rows.length };
  }

  return {
    db,
    reindex,
    vectorCandidates,
    queryVector,
    logEvent,
    state,
    qcache,
    // Waits for at most the batch in flight; a failed pass still closes the DB.
    close: async () => {
      closing = true;
      try {
        await indexing;
      } catch {
        // The pass's own caller reports its failure.
      } finally {
        if (db.isOpen) db.close();
      }
    },
  };
}

/**
 * The owner-search seam: a memory corpus supplement that proposes ids and cosine scores from the
 * stored vectors of every store and partition, after one query embed. It never returns text:
 * Knowledge validates each proposal with its own lookup under its owner gate and shows only its
 * own text. It answers only while Knowledge holds the memory slot, because memory-core reads every
 * supplement as its wiki corpus.
 */
export function ownerSupplement(vi, { isKnowledgeSlot, floor = 0.3 }) {
  return {
    async search({ query, maxResults }) {
      if (!isKnowledgeSlot()) return [];
      const topK = Math.min(Math.max(Number(maxResults) || 30, 1), 150);
      const { cands } = await vi.vectorCandidates(query, { topK, floor });
      return cands.map((c) => ({
        corpus: "knowledge-vectors",
        path: `${c.vaultId}/${c.partition}/${c.id}`,
        score: c.cos,
        snippet: "",
      }));
    },
    async get() {
      return null;
    },
  };
}
