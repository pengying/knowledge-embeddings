// The reindex scheduler (fake timers, hand-resolved passes) and the stores watcher
// (real fs.watch over a temp dir). No OpenClaw imports, no model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createReindexScheduler, isRelevantChange, watchKnowledgeStores } from "../knowledge-vectors-watch.js";

function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => (pending.set(++id, { fn, ms }), id),
    clearTimeout: (t) => pending.delete(t),
    fire() {
      for (const [t, { fn }] of [...pending]) {
        pending.delete(t);
        fn();
      }
    },
    get pending() {
      return [...pending.values()].map((p) => p.ms);
    },
  };
}

// Each pass waits until the test resolves it; counts calls and the most ever in flight.
function passes() {
  const waiting = [];
  const p = { calls: 0, inFlight: 0, maxInFlight: 0 };
  p.run = () => {
    p.calls++;
    p.inFlight++;
    p.maxInFlight = Math.max(p.maxInFlight, p.inFlight);
    return new Promise((resolve) => waiting.push(resolve)).finally(() => p.inFlight--);
  };
  p.finish = async () => {
    waiting.shift()?.();
    await flush();
  };
  return p;
}
const flush = () => new Promise((r) => setImmediate(r));

test("requests within the debounce window coalesce into one pass", async () => {
  const timers = fakeTimers(), p = passes();
  const s = createReindexScheduler({ run: p.run, debounceMs: 2000, timers });
  for (let i = 0; i < 5; i++) s.request();
  assert.deepEqual(timers.pending, [2000]);
  assert.equal(p.calls, 0);
  timers.fire();
  assert.equal(p.calls, 1);
  await p.finish();
  assert.equal(p.calls, 1);
  assert.equal(s.running, false);
});

test("a pass never overlaps another; changes during it run exactly one more", async () => {
  const timers = fakeTimers(), p = passes();
  const s = createReindexScheduler({ run: p.run, debounceMs: 10, timers });
  s.now();
  assert.equal(p.calls, 1);
  // Poll ticks and debounced changes while the pass runs.
  s.now();
  s.now();
  s.request();
  timers.fire();
  s.request();
  timers.fire();
  assert.equal(p.calls, 1);
  await p.finish();
  assert.equal(p.calls, 2);
  await p.finish();
  assert.equal(p.calls, 2);
  assert.equal(p.maxInFlight, 1);
  assert.equal(s.running, false);
});

test("a pass replaces a pending debounce; a failing pass does not stop the next", async () => {
  const timers = fakeTimers();
  let calls = 0;
  const s = createReindexScheduler({ run: async () => (calls++, Promise.reject(new Error("boom"))), timers });
  s.request();
  s.now();
  assert.deepEqual(timers.pending, []);
  await s.idle();
  s.request();
  timers.fire();
  await s.idle();
  assert.equal(calls, 2);
});

test("a debounce armed during a pass does not outlive the follow-up pass", async () => {
  const timers = fakeTimers(), p = passes();
  const s = createReindexScheduler({ run: p.run, debounceMs: 10, timers });
  s.now();
  s.request();
  s.now();
  assert.deepEqual(timers.pending, [10]);
  await p.finish();
  // The follow-up pass reads what the debounce was waiting for.
  assert.equal(p.calls, 2);
  assert.deepEqual(timers.pending, []);
  timers.fire();
  await p.finish();
  assert.equal(p.calls, 2);
  assert.equal(s.running, false);
});

test("stop() cancels a pending debounce and the follow-up pass", async () => {
  const timers = fakeTimers(), p = passes();
  const s = createReindexScheduler({ run: p.run, timers });
  s.request();
  s.stop();
  assert.deepEqual(timers.pending, []);
  s.request();
  s.now();
  assert.equal(p.calls, 0);

  const s2 = createReindexScheduler({ run: p.run, timers });
  s2.now();
  s2.now();
  s2.stop();
  await p.finish();
  assert.equal(p.calls, 1);
  assert.equal(s2.running, false);
});

test("only record-shaped paths count as changes", () => {
  for (const rel of ["claims/c1.md", "c1.md", "claims", "s1/claims/c2.md", "", null]) assert.equal(isRelevantChange(rel), true, rel);
  for (const rel of [
    ".git/index.lock",
    "claims/.c1.md.swp",
    "claims/c1.md.tmp",
    "claims/c1.md~",
    "claims/.#c1.md",
    "artifacts/a.md",
    "claims/note.json",
    "state.sqlite-wal",
    "store.lock",
    "x-journal",
  ])
    assert.equal(isRelevantChange(rel), false, rel);
});

const until = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};
const quiet = () => new Promise((r) => setTimeout(r, 150));
const record = (id) => `---\nformat: knowledge-record-v1\nid: ${id}\nrevision: 1\nkind: claim\ntitle: "${id}"\nlifecycle: active\n---\nbody\n`;

// A real watcher over a temp state dir; `rel` paths are under knowledge/stores.
async function realWatcher({ layout = [], watch } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "harrier-watch-"));
  const S = (...p) => path.join(stateDir, "knowledge", "stores", ...p);
  for (const d of layout) fs.mkdirSync(S(d), { recursive: true });
  const h = { stateDir, S, changes: 0, fails: [] };
  h.w = watchKnowledgeStores({
    stateDir,
    onChange: () => h.changes++,
    onFail: (e) => h.fails.push(e?.code ?? String(e)),
    ...(watch ? { watch: watch(h) } : {}),
  });
  await h.w.ready();
  h.watched = (...p) => h.w.dirs().includes(S(...p));
  // Writes a record and waits for it to count; false if it never does.
  h.sees = async (rel) => {
    await quiet();
    h.changes = 0;
    fs.writeFileSync(S(rel), record(path.basename(rel, ".md")));
    return until(() => h.changes > 0, 1000);
  };
  return h;
}

test("the watcher follows stores and partitions as they appear, and ignores Git and SQLite churn", async () => {
  const h = await realWatcher();
  const { w, S } = h;
  try {
    // No stores root yet: only the state dir is watched, for knowledge/.
    assert.deepEqual(w.dirs(), [h.stateDir]);
    fs.mkdirSync(S("s1", "vault", "private", "claims"), { recursive: true });
    assert.ok(await until(() => h.watched("s1", "vault", "private", "claims")), w.dirs().join("\n"));
    assert.deepEqual(w.dirs().sort(), [S(), S("s1", "vault"), S("s1", "vault", "private"), S("s1", "vault", "private", "claims")].sort());
    assert.ok(await h.sees("s1/vault/private/claims/c1.md"));

    // Knowledge's checkpoint commits, its own SQLite, temp files and artifacts are invisible.
    fs.mkdirSync(S("s1", "vault", ".git", "objects", "ab"), { recursive: true });
    fs.mkdirSync(S("s1", "vault", "private", "artifacts", "x"), { recursive: true });
    await quiet();
    assert.equal(w.dirs().some((d) => d.includes(".git") || d.includes("artifacts")), false);
    h.changes = 0;
    fs.writeFileSync(S("s1", "vault", ".git", "objects", "ab", "cdef"), "blob");
    fs.writeFileSync(S("s1", "vault", ".git", "index.lock"), "");
    fs.writeFileSync(S("s1", "state.sqlite"), "db");
    fs.writeFileSync(S("s1", "state.sqlite-wal"), "wal");
    fs.writeFileSync(S("s1", "vault", "private", "claims", "c1.md.tmp"), "half");
    fs.writeFileSync(S("s1", "vault", "private", "artifacts", "x", "a.md"), "attachment");
    await quiet();
    assert.equal(h.changes, 0);

    // A new conversation partition, then a record in it.
    fs.mkdirSync(S("s1", "vault", "conversations", "sid1", "claims"), { recursive: true });
    assert.ok(await until(() => h.watched("s1", "vault", "conversations", "sid1", "claims")), w.dirs().join("\n"));
    assert.ok(await h.sees("s1/vault/conversations/sid1/claims/c2.md"));

    // A second store, made in one go.
    fs.mkdirSync(S("s2", "vault", "private", "claims"), { recursive: true });
    assert.ok(await until(() => h.watched("s2", "vault", "private", "claims")), w.dirs().join("\n"));
    assert.ok(await h.sees("s2/vault/private/claims/c3.md"));
    assert.deepEqual(h.fails, []);
  } finally {
    w.close();
  }
  assert.equal(w.size, 0);
});

const VAULT_LAYOUT = ["s1/vault/private/claims"];

test("a new directory with a dot in its name is watched at once, and a plain file is not a change", async () => {
  const h = await realWatcher({ layout: VAULT_LAYOUT });
  try {
    fs.mkdirSync(h.S("s1", "vault", "private", "claims", "v1.0"));
    assert.ok(await until(() => h.watched("s1", "vault", "private", "claims", "v1.0")), h.w.dirs().join("\n"));
    assert.ok(await h.sees("s1/vault/private/claims/v1.0/c1.md"));
    await quiet();
    h.changes = 0;
    fs.writeFileSync(h.S("s1", "vault", "private", "claims", "notes.txt"), "not a record");
    await quiet();
    assert.equal(h.changes, 0);
    // Renamed away: its records are gone from what the index reads.
    fs.renameSync(h.S("s1", "vault", "private", "claims", "v1.0"), h.S("s1", "vault", "private", "claims", ".v1.0-old"));
    assert.ok(await until(() => h.changes > 0 && !h.watched("s1", "vault", "private", "claims", "v1.0")));
    assert.deepEqual(h.fails, []);
  } finally {
    h.w.close();
  }
});

test("a vault or partition deleted and made again is watched again", async () => {
  for (const part of [["vault"], ["vault", "private"]]) {
    const h = await realWatcher({ layout: VAULT_LAYOUT });
    try {
      fs.rmSync(h.S("s1", ...part), { recursive: true });
      assert.ok(await until(() => !h.watched("s1", "vault", "private")), part.join("/"));
      fs.mkdirSync(h.S("s1", "vault", "private", "claims"), { recursive: true });
      assert.ok(await until(() => h.watched("s1", "vault", "private", "claims")), part.join("/"));
      assert.ok(await h.sees("s1/vault/private/claims/c1.md"), part.join("/"));
      assert.deepEqual(h.fails, []);
    } finally {
      h.w.close();
    }
  }
});

test("a vault or partition renamed away is noticed by its own watcher", async () => {
  for (const part of [["vault"], ["vault", "private"]]) {
    const h = await realWatcher({ layout: VAULT_LAYOUT });
    try {
      const from = h.S("s1", ...part);
      fs.renameSync(from, `${from}.old`);
      // Only the moved directory's own watch hears this (nothing under it was deleted).
      assert.ok(await until(() => !h.watched("s1", "vault", "private")), part.join("/"));
      fs.mkdirSync(h.S("s1", "vault", "private", "claims"), { recursive: true });
      assert.ok(await until(() => h.watched("s1", "vault", "private", "claims")), part.join("/"));
      assert.ok(await h.sees("s1/vault/private/claims/c1.md"), part.join("/"));
    } finally {
      h.w.close();
    }
  }
});

test("a vault or partition swapped for a new one at the same path is watched afresh", async () => {
  for (const part of [["vault"], ["vault", "private"]]) {
    const h = await realWatcher({ layout: VAULT_LAYOUT });
    try {
      const at = h.S("s1", ...part);
      const fresh = `${at}.new`;
      fs.mkdirSync(path.join(fresh, ...(part.length === 1 ? ["private", "claims"] : ["claims"])), { recursive: true });
      // An atomic swap: the same paths, new directories.
      fs.renameSync(at, `${at}.old`);
      fs.renameSync(fresh, at);
      assert.ok(await h.sees("s1/vault/private/claims/c1.md"), part.join("/"));
      assert.ok(!h.w.dirs().some((d) => d.endsWith(".old") || d.endsWith(".new")));
    } finally {
      h.w.close();
    }
  }
});

test("a directory made between the scan and the watch on its parent is still found", async () => {
  // Make s2 at the last moment before the stores root is watched: its event is lost.
  const h = await realWatcher({
    layout: ["s1/vault/private"],
    watch: (h) => {
      let made = false;
      return (dir, opts, listener) => {
        if (!made && dir === h.S()) {
          made = true;
          fs.mkdirSync(h.S("s2", "vault", "private", "claims"), { recursive: true });
        }
        return fs.watch(dir, opts, listener);
      };
    },
  });
  try {
    assert.ok(h.watched("s2", "vault", "private", "claims"), h.w.dirs().join("\n"));
    assert.ok(await h.sees("s2/vault/private/claims/c1.md"));
  } finally {
    h.w.close();
  }
});

test("an unreadable directory made after the start fails over to polling, without throwing", async () => {
  const h = await realWatcher({ layout: VAULT_LAYOUT });
  const locked = h.S("s1", "vault", "private", "locked");
  try {
    fs.mkdirSync(path.join(locked, "deep"), { recursive: true });
    fs.chmodSync(locked, 0o000);
    assert.ok(await until(() => h.fails.length > 0));
    assert.deepEqual(h.fails, ["EACCES"]);
    assert.equal(h.w.size, 0);
  } finally {
    fs.chmodSync(locked, 0o755);
    h.w.close();
  }
});

test("EMFILE from readdir mid-refresh fails over instead of dropping watchers silently", async (t) => {
  const h = await realWatcher({ layout: VAULT_LAYOUT });
  try {
    assert.ok(h.w.size > 0);
    const emfile = Object.assign(new Error("too many open files"), { code: "EMFILE" });
    t.mock.method(fs.promises, "readdir", async () => {
      throw emfile;
    });
    await h.w.refresh();
    assert.deepEqual(h.fails, ["EMFILE"]);
    assert.equal(h.w.size, 0);
  } finally {
    h.w.close();
  }
});

// fs.watch stand-in that never emits by itself.
function fakeWatch(opened) {
  return (dir) => {
    const handle = Object.assign(new EventEmitter(), {
      dir,
      closed: false,
      close() {
        this.closed = true;
      },
    });
    opened.push(handle);
    return handle;
  };
}

test("a watch that throws, or errors later, fails over once and closes everything", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "harrier-watch-"));
  fs.mkdirSync(path.join(stateDir, "knowledge", "stores", "s1", "vault", "private"), { recursive: true });
  const emfile = Object.assign(new Error("too many open files"), { code: "EMFILE" });

  const fails = [];
  const throwing = watchKnowledgeStores({
    stateDir,
    onChange() {},
    onFail: (e) => fails.push(e.code),
    watch: () => {
      throw emfile;
    },
  });
  await throwing.ready();
  assert.deepEqual(fails, ["EMFILE"]);
  assert.equal(throwing.size, 0);

  const opened = [];
  const later = [];
  const w = watchKnowledgeStores({ stateDir, onChange() {}, onFail: (e) => later.push(e.code), watch: fakeWatch(opened) });
  await w.ready();
  assert.equal(opened.length, 3);
  opened[0].emit("error", emfile);
  opened[1].emit("error", emfile);
  assert.deepEqual(later, ["EMFILE"]);
  assert.ok(opened.every((h) => h.closed));
});

test("an error from a watcher already replaced is ignored", async () => {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "harrier-watch-"));
  const claims = path.join(stateDir, "knowledge", "stores", "s1", "vault", "private", "claims");
  fs.mkdirSync(claims, { recursive: true });
  const opened = [], fails = [];
  const w = watchKnowledgeStores({ stateDir, onChange() {}, onFail: (e) => fails.push(e.code), watch: fakeWatch(opened) });
  await w.ready();
  const stale = opened.find((h) => h.dir === claims);
  // Swap claims for a new directory: the refresh replaces its watcher.
  fs.rmSync(claims, { recursive: true });
  fs.mkdirSync(claims);
  await w.refresh();
  assert.ok(stale.closed);
  assert.equal(opened.filter((h) => h.dir === claims && !h.closed).length, 1);
  stale.emit("error", Object.assign(new Error("too many open files"), { code: "EMFILE" }));
  assert.deepEqual(fails, []);
  assert.equal(w.size, 4);
  w.close();
});
