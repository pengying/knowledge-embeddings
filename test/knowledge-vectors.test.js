// Knowledge vectors core: indexing, re-keying, the owner supplement and the store migrations.
// No OpenClaw imports: the embedder is a fake.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { CHUNK_TOKENS, createVectorIndex, embedChunks, estimateTokens, MIGRATIONS, migrate, ownerSupplement, parseRecord } from "../knowledge-vectors.js";

const VAULT = "11111111-1111-4111-8111-111111111111";
const OLD = "22222222-2222-4222-8222-222222222222",
  NEW = "33333333-3333-4333-8333-333333333333";

// A deterministic "embedding": one dimension per topic word, plus a small constant.
const fakeVec = (t) => [/court/i, /jersey/i, /volleyball/i].map((w) => (w.test(t) ? 1 : 0)).concat(0.01);

function record(dir, id, text) {
  fs.mkdirSync(path.join(dir, "claims"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "claims", `${id}.md`),
    `---\nformat: knowledge-record-v1\nid: ${id}\nrevision: 1\nkind: claim\ntitle: "${text}"\nlifecycle: active\n---\n${text}\n`,
  );
}

function fixture({ embedDocs, embedQuery, settings } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kvec-"));
  const vault = path.join(stateDir, "knowledge", "stores", VAULT, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, "vault.json"), JSON.stringify({ vaultId: VAULT }));
  record(path.join(vault, "private"), "p1", "Volleyball net is in the garage");
  record(path.join(vault, "conversations", OLD), "g1", "Court fees split four ways");
  record(path.join(vault, "conversations", OLD), "g2", "Jerseys arrive Friday");
  const embedded = [];
  const vi = createVectorIndex({
    dbPath: path.join(stateDir, "vectors.sqlite"),
    stateDir,
    embedDocs: async (texts) => {
      embedded.push(...texts);
      return embedDocs ? embedDocs(texts) : texts.map(fakeVec);
    },
    embedQuery: embedQuery ?? (async (q) => fakeVec(q)),
    settings: { batchSize: 2, indexInactive: false, ...settings },
  });
  return { stateDir, vault, vi, embedded };
}

test("a K1 re-key moves rows to the new partition with zero embeds", async () => {
  const f = fixture();
  assert.equal((await f.vi.reindex()).embedded, 3);
  // Turning conversationPartition on renames nothing in Knowledge; this simulates the new
  // directory holding the same records, as a re-save into the conversation-keyed partition would.
  fs.renameSync(path.join(f.vault, "conversations", OLD), path.join(f.vault, "conversations", NEW));
  const stats = await f.vi.reindex();
  assert.equal(stats.embedded, 0);
  assert.equal(stats.cacheHits, 2);
  assert.equal(stats.removedMissing, 2);
  assert.deepEqual(
    f.vi.db.prepare("SELECT partition, count(*) n FROM vectors GROUP BY 1 ORDER BY 1").all().map((r) => [r.partition, r.n]),
    [[`conversation:${NEW}`, 2], ["private", 1]],
  );
  assert.equal(f.embedded.length, 3);
});

test("the owner supplement proposes ids and scores only, and only in the Knowledge slot", async () => {
  const f = fixture();
  await f.vi.reindex();
  let slot = "knowledge";
  const supplement = ownerSupplement(f.vi, { isKnowledgeSlot: () => slot === "knowledge", floor: -1 });
  const out = await supplement.search({ query: "court", maxResults: 10 });
  assert.equal(out.length, 3);
  assert.deepEqual(out[0], {
    corpus: "knowledge-vectors",
    path: `${VAULT}/conversation:${OLD}/g1`,
    score: out[0].score,
    snippet: "",
  });
  assert.ok(out[0].score > 0.999);
  assert.doesNotMatch(JSON.stringify(out), /Court|Jerseys|Volleyball/);
  assert.equal(await supplement.get({ lookup: "g1" }), null);
  slot = "memory-core";
  assert.deepEqual(await supplement.search({ query: "court", maxResults: 10 }), []);
  assert.equal(f.embedded.length, 3);
});

const history = (db) =>
  db.prepare("SELECT version, description FROM schema_migrations ORDER BY version").all().map((r) => r.version);

test("a new store starts at the latest schema, and reopening changes nothing", async () => {
  const f = fixture();
  assert.deepEqual(history(f.vi.db), [1, 2]);
  await f.vi.reindex();
  await f.vi.close();
  const reopened = new DatabaseSync(path.join(f.stateDir, "vectors.sqlite"));
  assert.equal(migrate(reopened), MIGRATIONS.at(-1).version);
  assert.deepEqual(history(reopened), [1, 2]);
  assert.equal(reopened.prepare("SELECT count(*) AS n FROM vectors").get().n, 3);
});

test("the unversioned spike store is adopted in place with its rows and vectors", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kvec-spike-"));
  const db = new DatabaseSync(path.join(dir, "vectors.sqlite"));
  // The Design A spike layout: same tables, no migration history.
  MIGRATIONS[0].up(db);
  const vec = Buffer.from(new Float32Array([1, 0, 0, 0.01]).buffer);
  db.prepare("INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    VAULT, "private", "p1", 3, "h", "active", "claim", "t", "private/claims/p1.md", "th", vec, 1,
  );
  db.prepare("INSERT INTO embed_cache VALUES (?, ?)").run("th", vec);
  db.prepare("INSERT INTO tombstones VALUES (?,?,?,?,?)").run(VAULT, "private", "gone", 2, "withdrawn");
  assert.equal(migrate(db), 2);
  assert.deepEqual(history(db), [1, 2]);
  assert.deepEqual(
    { ...db.prepare("SELECT vault_id, partition, id, chunk, revision, text_hash FROM vectors").get() },
    { vault_id: VAULT, partition: "private", id: "p1", chunk: 0, revision: 3, text_hash: "th" },
  );
  assert.equal(Buffer.compare(db.prepare("SELECT vec FROM vectors").get().vec, vec), 0);
  assert.equal(Buffer.compare(db.prepare("SELECT vec FROM embed_cache").get().vec, vec), 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM tombstones").get().n, 1);
  assert.equal(migrate(db), 2);
  assert.deepEqual(history(db), [1, 2]);
});

test("a newer store is refused and left unchanged", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kvec-newer-"));
  const db = new DatabaseSync(path.join(dir, "vectors.sqlite"));
  migrate(db);
  db.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(3, "from a newer knowledge-embeddings", "2027-01-01");
  assert.throws(() => migrate(db), /schema 3, newer than this knowledge-embeddings plugin supports \(2\).*not changed/);
  assert.deepEqual(history(db), [1, 2, 3]);
});

test("opening a newer store fails without leaving its file handles open", { skip: !fs.existsSync("/proc/self/fd") && "needs /proc/self/fd" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kvec-newer-open-"));
  const dbPath = path.join(dir, "vectors.sqlite");
  const seed = new DatabaseSync(dbPath);
  migrate(seed);
  seed.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(99, "from a newer knowledge-embeddings", "2027-01-01");
  seed.close();
  const open = () =>
    fs.readdirSync("/proc/self/fd").filter((fd) => {
      try {
        return fs.readlinkSync(`/proc/self/fd/${fd}`).startsWith(dbPath);
      } catch {
        return false;
      }
    }).length;
  for (let i = 0; i < 3; i++) {
    assert.throws(
      () => createVectorIndex({ dbPath, stateDir: dir, embedDocs: async () => [], embedQuery: async () => [], settings: {} }),
      /schema 99, newer than this knowledge-embeddings plugin supports/,
    );
  }
  assert.equal(open(), 0);
});

test("a failed step rolls back, keeps the prior version, and runs once on retry", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kvec-fail-"));
  const db = new DatabaseSync(path.join(dir, "vectors.sqlite"));
  migrate(db);
  const failing = {
    version: 3,
    description: "test step",
    up: (d) => {
      d.exec("CREATE TABLE half_done (x)");
      throw new Error("interrupted");
    },
  };
  assert.throws(() => migrate(db, [...MIGRATIONS, failing]), /interrupted/);
  assert.deepEqual(history(db), [1, 2]);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'half_done'").get().n, 0);
  let runs = 0;
  const fixed = { ...failing, up: (d) => (runs++, d.exec("CREATE TABLE half_done (x)")) };
  assert.equal(migrate(db, [...MIGRATIONS, fixed]), 3);
  assert.equal(migrate(db, [...MIGRATIONS, fixed]), 3);
  assert.equal(runs, 1);
  assert.deepEqual(history(db), [1, 2, 3]);
});

const count = (db, sql) => db.prepare(sql).get().n;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
};

test("a record that never embeds is skipped and retried, and the rest is indexed", async () => {
  const f = fixture({
    embedDocs: async (texts) => {
      if (texts.some((t) => /poison/.test(t))) throw new Error("embed rejected input");
      return texts.map(fakeVec);
    },
  });
  record(path.join(f.vault, "private"), "p2", "poison record");
  const stats = await f.vi.reindex();
  assert.equal(stats.failed, 1);
  assert.equal(stats.inserted, 3);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM vectors"), 3);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'embed-failed'"), 1);
  // Retried next pass, but logged once.
  f.embedded.length = 0;
  const again = await f.vi.reindex();
  assert.equal(again.failed, 1);
  assert.ok(f.embedded.includes("poison record\npoison record\n"));
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'embed-failed'"), 1);
});

test("records that never embed do not abort the pass, are logged once, and the pass prunes", async () => {
  const f = fixture({
    settings: { batchSize: 1, eventsKeep: 50 },
    embedDocs: async (texts) => {
      if (texts.some((t) => /poison/.test(t))) throw new Error("input is longer than the context");
      return texts.map(fakeVec);
    },
  });
  for (let i = 0; i < 60; i++) f.vi.logEvent("old", null, null);
  for (let i = 0; i < 3; i++) record(path.join(f.vault, "private"), `bad${i}`, `poison ${i}`);
  for (let pass = 0; pass < 2; pass++) {
    const stats = await f.vi.reindex();
    assert.equal(stats.failed, 3);
    assert.equal(stats.aborted, undefined);
  }
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM vectors"), 3);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'embed-failed'"), 3);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'reindex'"), 1);
  assert.ok(count(f.vi.db, "SELECT count(*) n FROM events") <= 50);
});

test("an embedder that goes down mid-pass aborts it, still logging the record that failed alone", async () => {
  let down = false, poisonFailed = false;
  const f = fixture({
    settings: { batchSize: 1 },
    embedDocs: async (texts) => {
      if (down) throw new Error("llama down");
      if (texts.some((t) => /poison/.test(t))) {
        poisonFailed = true;
        throw new Error("input is longer than the context");
      }
      // The next embed after the poison works, then llama.cpp stops.
      if (poisonFailed) down = true;
      return texts.map(fakeVec);
    },
  });
  // Private records are read before conversation ones: the poison comes early.
  record(path.join(f.vault, "private"), "bad", "poison");
  for (let i = 0; i < 4; i++) record(path.join(f.vault, "conversations", OLD), `x${i}`, `extra ${i}`);
  await assert.rejects(f.vi.reindex(), /llama down/);
  assert.deepEqual(f.vi.db.prepare("SELECT id FROM events WHERE kind = 'embed-failed'").all().map((r) => r.id), ["bad"]);
  assert.match(f.vi.db.prepare("SELECT detail FROM events WHERE kind = 'reindex'").get().detail, /"aborted":"llama down"/);
});

test("a long record is split into chunks that each fit the embedding context and together cover it", () => {
  const rec = (body, title = "") => ({ title, aliases: [], body });
  const utf8 = (t) => Buffer.byteLength(t, "utf8");
  // Numbered CJK sentences, so coverage can be checked one by one.
  const sentences = Array.from({ length: 400 }, (_, i) => `第${i}句記錄內容。`);
  const chunks = embedChunks(rec(sentences.join("")));
  assert.ok(chunks.length > 3, `${chunks.length} chunks`);
  // A byte-level BPE never uses more tokens than UTF-8 bytes, so for CJK this bound is strict.
  for (const c of chunks) assert.ok(utf8(c) <= CHUNK_TOKENS, `${utf8(c)} bytes`);
  for (const sentence of sentences) assert.ok(chunks.some((c) => c.includes(sentence)), sentence);
  // Chunks end at a sentence and overlap a little.
  assert.ok(chunks.slice(0, -1).every((c) => c.endsWith("。")));
  assert.ok(chunks.slice(1).every((c, i) => c.startsWith("第") && chunks[i].includes(c.slice(0, c.indexOf("。") + 1))));
  for (const body of ["😀".repeat(3000), "1234567890 ".repeat(1000)]) {
    const parts = embedChunks(rec(body));
    assert.ok(parts.length > 1 && parts.every((c) => utf8(c) <= CHUNK_TOKENS && c.isWellFormed()));
  }
  // ASCII letters are estimated, not bounded by bytes.
  const letters = embedChunks(rec("x".repeat(20000)));
  assert.ok(letters.length > 1 && letters.every((c) => estimateTokens(c) <= CHUNK_TOKENS));
  assert.equal(letters.join("").length >= 20000, true);
  // Every chunk keeps the title; a short record is one text, exactly as before chunking.
  assert.ok(embedChunks(rec("記錄".repeat(3000), "Long notes")).every((c) => c.startsWith("Long notes\n") && estimateTokens(c) <= CHUNK_TOKENS));
  assert.deepEqual(embedChunks(rec("short", "Title")), ["Title\nshort"]);
  assert.deepEqual(embedChunks(rec("")), [""]);
});

// A long CJK record whose only "volleyball" is in its last chunk.
function longRecord(dir, id, tail = "volleyball") {
  fs.mkdirSync(path.join(dir, "notes"), { recursive: true });
  const body = Array.from({ length: 400 }, (_, i) => `第${i}句記錄內容。`).join("") + tail;
  fs.writeFileSync(
    path.join(dir, "notes", `${id}.md`),
    `---\nformat: knowledge-record-v1\nid: ${id}\nrevision: 1\nkind: note\ntitle: Long notes\nlifecycle: active\n---\n${body}\n`,
  );
  return path.join(dir, "notes", `${id}.md`);
}
const chunksOf = (db, id) => db.prepare("SELECT chunk FROM vectors WHERE id = ? ORDER BY chunk").all(id).map((r) => r.chunk);

test("every chunk of a long record is embedded, and a query matching only its last chunk finds it once", async () => {
  const f = fixture();
  const file = longRecord(path.join(f.vault, "private"), "long");
  const stats = await f.vi.reindex();
  const n = embedChunks(parseRecord(fs.readFileSync(file, "utf8"))).length;
  assert.ok(n > 3);
  assert.equal(stats.inserted, 4);
  assert.equal(stats.embedded, 3 + n);
  assert.deepEqual(chunksOf(f.vi.db, "long"), [...Array(n).keys()]);
  const search = (floor) => ownerSupplement(f.vi, { isKnowledgeSlot: () => true, floor }).search({ query: "volleyball", maxResults: 50 });
  const hits = (await search(0.5)).map((h) => h.path.split("/").at(-1));
  assert.deepEqual(hits.sort(), ["long", "p1"]);
  // Each record once, however many chunks it has.
  assert.deepEqual((await search(-1)).map((h) => h.path.split("/").at(-1)).sort(), ["g1", "g2", "long", "p1"]);
  const [best] = (await f.vi.vectorCandidates("volleyball", { topK: 50, floor: 0.5 })).cands.filter((c) => c.id === "long");
  assert.equal(best.chunk, n - 1);
});

test("a record's chunks are replaced together, and deleting it removes all of them", async () => {
  const f = fixture();
  const file = longRecord(path.join(f.vault, "private"), "long");
  await f.vi.reindex();
  assert.ok(chunksOf(f.vi.db, "long").length > 3);
  // Shrunk to one chunk: the others go.
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n---\n[\s\S]*$/u, "\n---\nnow short\n"));
  assert.equal((await f.vi.reindex()).replaced, 1);
  assert.deepEqual(chunksOf(f.vi.db, "long"), [0]);
  longRecord(path.join(f.vault, "private"), "long");
  await f.vi.reindex();
  fs.rmSync(file);
  const stats = await f.vi.reindex();
  assert.equal(stats.removedMissing, 1);
  assert.deepEqual(chunksOf(f.vi.db, "long"), []);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'drop-missing'"), 1);
});

test("a chunk that never embeds is skipped and retried; the record's other chunks are stored and found", async () => {
  const f = fixture({
    settings: { batchSize: 1 },
    embedDocs: async (texts) => {
      if (texts.some((t) => /第200句/.test(t))) throw new Error("input is longer than the context");
      return texts.map(fakeVec);
    },
  });
  longRecord(path.join(f.vault, "private"), "long");
  const first = await f.vi.reindex();
  assert.ok(first.failed >= 1);
  assert.equal(first.aborted, undefined);
  const stored = chunksOf(f.vi.db, "long");
  assert.equal(stored.length, first.chunks - 3 - first.failed);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'embed-failed'"), first.failed);
  const supplement = ownerSupplement(f.vi, { isKnowledgeSlot: () => true, floor: 0.5 });
  assert.ok((await supplement.search({ query: "volleyball", maxResults: 10 })).some((h) => h.path.endsWith("/long")));
  // Retried every pass from the cache, with nothing new to log.
  const events = count(f.vi.db, "SELECT count(*) n FROM events");
  const again = await f.vi.reindex();
  assert.equal(again.failed, first.failed);
  assert.equal(again.embedded, 0);
  assert.equal(again.refreshed, 1);
  assert.deepEqual(chunksOf(f.vi.db, "long"), stored);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events"), events);
});

test("a schema 1 store migrates to one row per chunk; a capped record is re-embedded once", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "kvec-v1-"));
  const vault = path.join(stateDir, "knowledge", "stores", VAULT, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.writeFileSync(path.join(vault, "vault.json"), JSON.stringify({ vaultId: VAULT }));
  record(path.join(vault, "private"), "p1", "Volleyball net is in the garage");
  const longFile = longRecord(path.join(vault, "private"), "long");
  // The store as 0.2.x left it: schema 1, one row per record, the long one embedded cut short.
  const dbPath = path.join(stateDir, "vectors.sqlite");
  const old = new DatabaseSync(dbPath);
  migrate(old, MIGRATIONS.slice(0, 1));
  const sha = (t) => createHash("sha256").update(t).digest("hex");
  const vec = (t) => Buffer.from(new Float32Array(fakeVec(t)).buffer);
  const shortText = "Volleyball net is in the garage\nVolleyball net is in the garage\n";
  const longText = `Long notes\n${fs.readFileSync(longFile, "utf8").split("\n---\n")[1]}`.slice(0, 6000);
  for (const [id, text, file] of [["p1", shortText, "private/claims/p1.md"], ["long", longText, "private/notes/long.md"]]) {
    old.prepare("INSERT INTO vectors VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(VAULT, "private", id, 1, "old-hash", "active", "claim", "t", file, sha(text), vec(text), 1);
    old.prepare("INSERT INTO embed_cache VALUES (?, ?)").run(sha(text), vec(text));
  }
  old.close();

  const embedded = [];
  const vi = createVectorIndex({
    dbPath,
    stateDir,
    embedDocs: async (texts) => (embedded.push(...texts), texts.map(fakeVec)),
    embedQuery: async (q) => fakeVec(q),
    settings: { batchSize: 2 },
  });
  assert.deepEqual(history(vi.db), [1, 2]);
  assert.deepEqual(
    vi.db.prepare("SELECT id, chunk, hash FROM vectors ORDER BY id").all().map((r) => ({ ...r })),
    [{ id: "long", chunk: 0, hash: null }, { id: "p1", chunk: 0, hash: null }],
  );
  const stats = await vi.reindex();
  // p1's text is unchanged: from the cache, silently. The long record is embedded whole, in chunks.
  assert.equal(embedded.includes(shortText), false);
  assert.equal(stats.refreshed, 1);
  assert.equal(stats.replaced, 1);
  assert.ok(chunksOf(vi.db, "long").length > 3);
  assert.equal(embedded.length, chunksOf(vi.db, "long").length);
  const again = await vi.reindex();
  assert.equal(again.embedded, 0);
  assert.equal(again.unchanged, 2);
  // Reopening runs nothing again.
  await vi.close();
  const reopened = new DatabaseSync(dbPath);
  assert.equal(migrate(reopened), 2);
  assert.deepEqual(history(reopened), [1, 2]);
});

test("a down embedder aborts the pass, keeping what was already embedded", async () => {
  let calls = 0;
  const f = fixture({
    embedDocs: async (texts) => {
      if (++calls > 1) throw new Error("llama down");
      return texts.map(fakeVec);
    },
  });
  for (let i = 0; i < 6; i++) record(path.join(f.vault, "private"), `x${i}`, `extra ${i}`);
  await assert.rejects(f.vi.reindex(), /llama down/);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM vectors"), 2);
  assert.ok(calls < 8);
});

test("each batch is searchable before the pass ends, and close() stops after the batch in flight", async () => {
  const gate = deferred();
  let batches = 0;
  const f = fixture({
    embedDocs: async (texts) => {
      if (++batches === 2) await gate.promise;
      return texts.map(fakeVec);
    },
  });
  for (let i = 0; i < 20; i++) record(path.join(f.vault, "private"), `x${i}`, `extra ${i}`);
  const pass = f.vi.reindex();
  while (batches < 2) await new Promise((r) => setTimeout(r, 1));
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM vectors"), 2);
  const closed = f.vi.close();
  gate.resolve();
  await closed;
  assert.equal(batches, 2);
  assert.equal((await pass).cancelled, true);
  assert.equal(f.vi.db.isOpen, false);
});

test("close() closes the DB even when the pass in flight rejects", async () => {
  const gate = deferred();
  let started = false;
  const f = fixture({
    embedDocs: async () => {
      started = true;
      await gate.promise;
      throw new Error("llama stopped first");
    },
  });
  const pass = f.vi.reindex();
  pass.catch(() => {});
  while (!started) await new Promise((r) => setTimeout(r, 1));
  const closed = f.vi.close();
  gate.reject(new Error("llama stopped first"));
  await closed;
  assert.equal(f.vi.db.isOpen, false);
});

test("a search whose query embed finishes after close() answers empty", async () => {
  const gate = deferred();
  const f = fixture({ embedQuery: () => gate.promise });
  await f.vi.reindex();
  const search = f.vi.vectorCandidates("court", { topK: 5, floor: -1 });
  await f.vi.close();
  gate.resolve(fakeVec("court"));
  assert.deepEqual((await search).cands, []);
});

test("the same id in two partitions is proposed once per partition", async () => {
  const f = fixture();
  record(path.join(f.vault, "private"), "g1", "Court fees split four ways");
  await f.vi.reindex();
  const supplement = ownerSupplement(f.vi, { isKnowledgeSlot: () => true, floor: 0.5 });
  const out = await supplement.search({ query: "court", maxResults: 10 });
  assert.deepEqual(out.map((r) => r.path).sort(), [`${VAULT}/conversation:${OLD}/g1`, `${VAULT}/private/g1`]);
});

test("a pass that changes nothing writes no events", async () => {
  const f = fixture();
  // No revision line: the record must still count as unchanged, not replaced every pass.
  fs.writeFileSync(
    path.join(f.vault, "private", "claims", "norev.md"),
    "---\nformat: knowledge-record-v1\nid: norev\nkind: claim\nlifecycle: active\n---\nCourt booking\n",
  );
  await f.vi.reindex();
  const before = count(f.vi.db, "SELECT count(*) n FROM events");
  const stats = await f.vi.reindex();
  assert.equal(stats.unchanged, 4);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events"), before);
});

test("a blocked stale restore is logged once, not every pass", async () => {
  const f = fixture();
  await f.vi.reindex();
  const file = path.join(f.vault, "private", "claims", "p1.md");
  const active = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, active.replace("revision: 1", "revision: 2").replace("lifecycle: active", "lifecycle: withdrawn"));
  await f.vi.reindex();
  fs.writeFileSync(file, active);
  for (let i = 0; i < 3; i++) assert.equal((await f.vi.reindex()).staleRestoreBlocked, 1);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'stale-restore-blocked'"), 1);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'reindex'"), 3);
});

test("the events table keeps only the newest rows", async () => {
  const f = fixture({ settings: { eventsKeep: 5 } });
  for (let i = 0; i < 20; i++) f.vi.logEvent("old", null, null);
  await f.vi.reindex();
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events"), 5);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM events WHERE kind = 'reindex'"), 1);
});

test("a withdrawn record is dropped, and a stale active copy stays out until a newer revision", async () => {
  const f = fixture();
  await f.vi.reindex();
  const file = path.join(f.vault, "private", "claims", "p1.md");
  const active = fs.readFileSync(file, "utf8");
  const rows = () => f.vi.db.prepare("SELECT id FROM vectors WHERE partition = 'private'").all().map((r) => r.id);
  fs.writeFileSync(file, active.replace("revision: 1", "revision: 2").replace("lifecycle: active", "lifecycle: withdrawn"));
  assert.equal((await f.vi.reindex()).dropped, 1);
  assert.deepEqual(rows(), []);
  // A restored copy at an older revision is blocked by the tombstone.
  fs.writeFileSync(file, active);
  assert.equal((await f.vi.reindex()).staleRestoreBlocked, 1);
  assert.deepEqual(rows(), []);
  // A genuinely newer revision is indexed again and clears the tombstone.
  fs.writeFileSync(file, active.replace("revision: 1", "revision: 3"));
  const stats = await f.vi.reindex();
  assert.equal(stats.staleRestoreBlocked, 0);
  assert.equal(stats.embedded, 0);
  assert.deepEqual(rows(), ["p1"]);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM tombstones"), 0);
});

test("outside the Knowledge slot the supplement embeds no query", async () => {
  const queries = [];
  const f = fixture({ embedQuery: async (q) => (queries.push(q), fakeVec(q)) });
  await f.vi.reindex();
  const supplement = ownerSupplement(f.vi, { isKnowledgeSlot: () => false, floor: -1 });
  assert.deepEqual(await supplement.search({ query: "jersey sizes", maxResults: 10 }), []);
  assert.deepEqual(queries, []);
});

test("the supplement proposes nothing below the floor and at most maxResults", async () => {
  const f = fixture();
  record(path.join(f.vault, "private"), "p2", "Court and jersey day");
  await f.vi.reindex();
  const search = (floor, maxResults) =>
    ownerSupplement(f.vi, { isKnowledgeSlot: () => true, floor }).search({ query: "court", maxResults });
  // "court" scores ~1.0 on g1, ~0.71 on p2 and ~0.01 on the rest.
  assert.deepEqual((await search(0.5, 10)).map((r) => r.path.split("/").at(-1)), ["g1", "p2"]);
  assert.deepEqual((await search(0.8, 10)).map((r) => r.path.split("/").at(-1)), ["g1"]);
  assert.equal((await search(-1, 2)).length, 2);
  assert.equal((await search(-1, 10)).length, 4);
});

// Written by Knowledge's yaml library (yaml 2.9, default 80-column width), which folds long values.
const FOLDED = [
  "---",
  "format: knowledge-record-v1",
  "id: abc",
  "revision: 2",
  "title: A very long Knowledge record title that goes well past eighty columns so",
  "  the yaml writer folds it onto lines",
  "kind: claim",
  "aliases:",
  "  - short",
  "  - an alias that is long enough to be folded by the yaml writer because it",
  "    passes eighty cols",
  "scope:",
  "  owner: someone with a fairly long owner value that might also need folding",
  "    beyond eighty columns",
  'attribution: "Source: some document section, long enough to fold onto',
  '  continuation lines in the yaml output here"',
  "lifecycle: active",
  "---",
  "Body text",
  "",
].join("\n");

test("folded frontmatter values are read whole, as Knowledge's yaml writer wrote them", () => {
  const r = parseRecord(FOLDED);
  assert.equal(r.title, "A very long Knowledge record title that goes well past eighty columns so the yaml writer folds it onto lines");
  assert.deepEqual(r.aliases, ["short", "an alias that is long enough to be folded by the yaml writer because it passes eighty cols"]);
  assert.deepEqual(r.scope, { owner: "someone with a fairly long owner value that might also need folding beyond eighty columns" });
  assert.equal(r.attribution, "Source: some document section, long enough to fold onto continuation lines in the yaml output here");
  assert.equal(r.lifecycle, "active");
  assert.equal(r.revision, 2);
  assert.equal(r.body, "Body text\n");
});

test("quoted, escaped and block-scalar frontmatter values decode as YAML reads them", () => {
  const raw = [
    "---",
    "format: knowledge-record-v1",
    "id: q",
    'title: "Bell\\a rings: then  two  spaces   and a long tail that must fold past',
    '  the eighty column width limit ok"',
    "kind: 'it''s quoted: and long enough to fold past the eighty column default",
    "  width'",
    "attribution: >-",
    "  word word",
    "  word",
    "",
    "",
    "  second paragraph",
    "superseded_by: |-",
    "  line one",
    "  line two",
    "---",
    "",
  ].join("\n");
  const r = parseRecord(raw);
  assert.equal(r.title, "Bell\u0007 rings: then  two  spaces   and a long tail that must fold past the eighty column width limit ok");
  assert.equal(r.kind, "it's quoted: and long enough to fold past the eighty column default width");
  assert.equal(r.attribution, "word word word\n\nsecond paragraph");
  assert.equal(r.supersededBy, "line one\nline two");
  // An indentation indicator, a quoted value across an empty line, an escaped trailing space
  // and an escaped line break (all as yaml 2.9 writes or reads them).
  const more = parseRecord(
    [
      "---",
      "format: knowledge-record-v1",
      "id: m",
      "title: |2-",
      "    lead",
      "  second",
      'kind: "ends with a tab and a bell \\a and is long enough to fold past the eighty',
      "  col\\t",
      "",
      '  second para "',
      "aliases:",
      '  - "escaped space\\ ',
      '    next"',
      '  - "joined\\',
      '    word"',
      "---",
      "",
    ].join("\n"),
  );
  assert.equal(more.title, "  lead\nsecond");
  assert.equal(more.kind, "ends with a tab and a bell \u0007 and is long enough to fold past the eighty col\t\nsecond para ");
  assert.deepEqual(more.aliases, ["escaped space  next", "joinedword"]);
});

test("CRLF line endings, a BOM and a frontmatter closed at the end of the file all parse", () => {
  const crlf = parseRecord(FOLDED.replace(/\n/g, "\r\n"));
  assert.equal(crlf.id, "abc");
  assert.equal(crlf.title, parseRecord(FOLDED).title);
  assert.equal(crlf.body, "Body text\n");
  const bom = parseRecord(`\uFEFF${FOLDED}`);
  assert.equal(bom.id, "abc");
  const eof = parseRecord("---\nformat: knowledge-record-v1\nid: e\nrevision: 1\n---");
  assert.equal(eof.id, "e");
  assert.equal(eof.body, "");
  // A longer dash line is not the closing marker.
  assert.equal(parseRecord("---\nformat: knowledge-record-v1\nid: d\n----\nnot frontmatter\n"), null);
});

test("a missing or invalid revision is unknown, and a stale copy without one stays blocked", async () => {
  for (const rev of ["", "revision: x\n", "revision: 0\n", "revision: 1.5\n"]) {
    assert.equal(parseRecord(`---\nformat: knowledge-record-v1\nid: r\n${rev}---\n`).revision, null, rev);
  }
  const f = fixture();
  await f.vi.reindex();
  const file = path.join(f.vault, "private", "claims", "p1.md");
  const active = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, active.replace("revision: 1", "revision: 3").replace("lifecycle: active", "lifecycle: withdrawn"));
  await f.vi.reindex();
  fs.writeFileSync(file, active.replace("revision: 1\n", ""));
  const stats = await f.vi.reindex();
  assert.equal(stats.staleRestoreBlocked, 1);
  assert.equal(stats.inserted, 0);
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM tombstones"), 1);
});

const asRoot = process.getuid?.() === 0;

test("a directory or record that cannot be read keeps its vectors instead of being pruned", { skip: (asRoot || process.platform === "win32") && "needs file permissions" }, async (t) => {
  const f = fixture();
  await f.vi.reindex();
  const rows = () => count(f.vi.db, "SELECT count(*) n FROM vectors");
  assert.equal(rows(), 3);
  const conversation = path.join(f.vault, "conversations", OLD);
  const file = path.join(f.vault, "private", "claims", "p1.md");
  fs.chmodSync(conversation, 0o000);
  fs.chmodSync(file, 0o000);
  t.after(() => {
    fs.chmodSync(conversation, 0o755);
    fs.chmodSync(file, 0o644);
  });
  const stats = await f.vi.reindex();
  assert.equal(stats.removedMissing, 0);
  assert.equal(stats.unreadable, 2);
  assert.equal(rows(), 3);
  // Readable again, and a record really deleted meanwhile: now it goes.
  fs.chmodSync(conversation, 0o755);
  fs.chmodSync(file, 0o644);
  fs.rmSync(path.join(conversation, "claims", "g2.md"));
  const after = await f.vi.reindex();
  assert.equal(after.unreadable, 0);
  assert.equal(after.removedMissing, 1);
  assert.equal(rows(), 2);
});

test("an unreadable stores root fails the pass and prunes nothing", { skip: (asRoot || process.platform === "win32") && "needs file permissions" }, async (t) => {
  const f = fixture();
  await f.vi.reindex();
  const root = path.join(f.stateDir, "knowledge", "stores");
  fs.chmodSync(root, 0o000);
  t.after(() => fs.chmodSync(root, 0o755));
  await assert.rejects(f.vi.reindex(), { code: "EACCES" });
  assert.equal(count(f.vi.db, "SELECT count(*) n FROM vectors"), 3);
});
