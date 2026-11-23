// Knowledge vectors wiring: every piece stays off unless its flag is on.
// A fake plugin API and adapter; no OpenClaw imports, no model.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { execFileSync } from "node:child_process";
import {
  KNOWLEDGE_VECTORS_DB,
  POLL_MS,
  WATCH_POLL_MS,
  knowledgeAsksForVectors,
  memorySearchUsesHarrier,
  migrationHints,
  pluginSettings,
  registerKnowledgeVectors,
  resolveSettings,
  wiringHints,
} from "../knowledge-vectors-service.js";
import { createVectorIndex } from "../knowledge-vectors.js";

const VAULT = "11111111-1111-4111-8111-111111111111";
const fakeVec = (t) => [/court/i, /jersey/i].map((w) => (w.test(t) ? 1 : 0)).concat(0.01);

function host(pluginConfig, { slot = "knowledge", embed = async (q) => fakeVec(q), createIndex, watch, config } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "harrier-kv-"));
  const claims = path.join(stateDir, "knowledge", "stores", VAULT, "vault", "private", "claims");
  fs.mkdirSync(claims, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "knowledge", "stores", VAULT, "vault", "vault.json"), JSON.stringify({ vaultId: VAULT }));
  fs.writeFileSync(
    path.join(claims, "c1.md"),
    "---\nformat: knowledge-record-v1\nid: c1\nrevision: 1\nkind: claim\ntitle: \"Court fees\"\nlifecycle: active\n---\nCourt fees split four ways\n",
  );
  const services = [],
    supplements = [],
    creates = [],
    queries = [],
    warnings = [];
  const current = config ?? { plugins: { slots: { memory: slot } } };
  const api = {
    pluginConfig,
    ...(config ? { config } : {}),
    runtime: {
      config: { current: () => current },
      state: { resolveStateDir: () => stateDir },
      llm: { acquireLocalService() {} },
    },
    logger: { info() {}, warn: (m) => warnings.push(m) },
    registerService: (s) => services.push(s),
    registerMemoryCorpusSupplement: (s) => supplements.push(s),
  };
  const adapter = {
    create: async (options) => {
      creates.push(options);
      return {
        provider: {
          embed: async (q, o) => (queries.push([q, o.inputType]), embed(q)),
          embedBatch: async (texts) => texts.map(fakeVec),
        },
      };
    },
  };
  registerKnowledgeVectors(api, adapter, { createIndex, watch });
  return { stateDir, claims, services, supplements, creates, queries, warnings };
}
const settle = () => new Promise((r) => setTimeout(r, 50));

test("nothing registers, opens or embeds with every flag off", () => {
  for (const config of [undefined, {}, { knowledgeVectors: { ownerSupplement: true } }]) {
    const h = host(config);
    assert.deepEqual([h.services.length, h.supplements.length, h.creates.length], [0, 0, 0]);
    assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), false);
  }
});

test("warm-up embeds one query when the service starts; a failure only logs", async () => {
  const h = host({ warmUp: true });
  assert.equal(h.supplements.length, 0);
  await h.services[0].start();
  await settle();
  assert.deepEqual(h.queries, [["warm-up", "query"]]);
  assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), false);
  const failing = host({ warmUp: true }, { embed: async () => Promise.reject(new Error("llama down")) });
  await failing.services[0].start();
  await settle();
  assert.match(failing.warnings.join("\n"), /warm-up failed: llama down/);
});

test("the supplement registers only with both flags, and answers only after start in the Knowledge slot", async () => {
  const indexOnly = host({ knowledgeVectors: { enabled: true, intervalMs: 0 } });
  assert.deepEqual([indexOnly.services.length, indexOnly.supplements.length], [1, 0]);

  const h = host({ knowledgeVectors: { enabled: true, ownerSupplement: true, intervalMs: 0 } });
  const [supplement] = h.supplements;
  assert.deepEqual(await supplement.search({ query: "court", maxResults: 5 }), []);
  assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), false);
  await h.services[0].start();
  let out = [];
  for (let i = 0; i < 40 && !out.length; i++) {
    await settle();
    out = await supplement.search({ query: "court", maxResults: 5 });
  }
  assert.deepEqual(out, [{ corpus: "knowledge-vectors", path: `${VAULT}/private/c1`, score: out[0].score, snippet: "" }]);
  assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), true);
  await h.services[0].stop();
  assert.deepEqual(await supplement.search({ query: "court", maxResults: 5 }), []);

  // warmUp off: only the supplement could embed here, and it must not outside the Knowledge slot.
  const other = host({ warmUp: false, knowledgeVectors: { enabled: true, ownerSupplement: true, intervalMs: 0 } }, { slot: "memory-core" });
  await other.services[0].start();
  await settle();
  assert.deepEqual(await other.supplements[0].search({ query: "jersey sizes", maxResults: 5 }), []);
  assert.deepEqual(other.queries, []);
  await other.services[0].stop();
});

// Knowledge's owner search naming this plugin, the one switch for Knowledge vectors.
const knowledgeConfig = ({ ownerSearch = { enabled: true, vectors: { plugin: "knowledge-embeddings" } }, slot = "knowledge", memory, knowledgeEnabled } = {}) => ({
  plugins: {
    // slot null: unset, which the host reads as memory-core.
    slots: slot === null ? {} : { memory: slot },
    entries: { knowledge: { ...(knowledgeEnabled === undefined ? {} : { enabled: knowledgeEnabled }), config: { ownerSearch } } },
  },
  ...(memory ? { memory } : {}),
});

test("Knowledge asks for vectors only when it holds the memory slot and its owner search is on and names knowledge-embeddings", () => {
  assert.equal(knowledgeAsksForVectors(knowledgeConfig()), true);
  assert.equal(knowledgeAsksForVectors(knowledgeConfig({ knowledgeEnabled: true })), true);
  for (const config of [
    undefined,
    {},
    knowledgeConfig({ knowledgeEnabled: false }),
    knowledgeConfig({ ownerSearch: { vectors: { plugin: "knowledge-embeddings" } } }),
    knowledgeConfig({ ownerSearch: { enabled: false, vectors: { plugin: "knowledge-embeddings" } } }),
    knowledgeConfig({ ownerSearch: { enabled: true, vectors: { plugin: "other-vectors" } } }),
    knowledgeConfig({ ownerSearch: { enabled: true } }),
    knowledgeConfig({ slot: "memory-core" }),
    knowledgeConfig({ slot: null }),
  ]) {
    assert.equal(knowledgeAsksForVectors(config), false, JSON.stringify(config));
  }
});

test("memory search uses Harrier globally or for any agent, unless that search is disabled", () => {
  assert.equal(memorySearchUsesHarrier({ memory: { search: { provider: "harrier-local" } } }), true);
  assert.equal(memorySearchUsesHarrier({ agents: { list: [{ id: "a" }, { id: "b", memory: { search: { provider: "harrier-local" } } }] } }), true);
  assert.equal(memorySearchUsesHarrier({ memory: { search: { provider: "harrier-local", enabled: false } } }), false);
  assert.equal(memorySearchUsesHarrier({ memory: { search: { provider: "local" } } }), false);
  assert.equal(memorySearchUsesHarrier({ agents: { list: "not a list" } }), false);
  assert.equal(memorySearchUsesHarrier(undefined), false);
  // Agent fields override the top-level ones, as in core: an agent can turn on a disabled default...
  const off = { provider: "harrier-local", enabled: false };
  assert.equal(memorySearchUsesHarrier({ memory: { search: off }, agents: { list: [{ id: "a", memory: { search: { enabled: true } } }] } }), true);
  assert.equal(memorySearchUsesHarrier({ memory: { search: off }, agents: { list: [{ id: "a" }] } }), false);
  // ...or inherit Harrier while overriding something else, or switch to Harrier from another provider.
  assert.equal(memorySearchUsesHarrier({ memory: { search: { provider: "local", enabled: false } }, agents: { list: [{ id: "a", memory: { search: { provider: "harrier-local", enabled: true } } }] } }), true);
  assert.equal(memorySearchUsesHarrier({ memory: { search: { enabled: false } }, agents: { list: [{ id: "a", memory: { search: { provider: "harrier-local" } } }] } }), false);
});

test("settings: an explicit value wins; otherwise Knowledge's switch and Harrier use decide", () => {
  const asked = knowledgeConfig();
  const harrierSearch = { memory: { search: { provider: "harrier-local" } } };
  const cases = [
    // [pluginConfig, config, expected]
    [undefined, {}, { warmUp: false, enabled: false, ownerSupplement: false, asked: false, named: false }],
    [undefined, harrierSearch, { warmUp: true, enabled: false, ownerSupplement: false, asked: false, named: false }],
    [{ warmUp: false }, harrierSearch, { warmUp: false, enabled: false, ownerSupplement: false, asked: false, named: false }],
    [undefined, asked, { warmUp: true, enabled: true, ownerSupplement: true, asked: true, named: true }],
    [{ knowledgeVectors: {} }, asked, { warmUp: true, enabled: true, ownerSupplement: true, asked: true, named: true }],
    [{ knowledgeVectors: { enabled: false } }, asked, { warmUp: false, enabled: false, ownerSupplement: false, asked: true, named: true }],
    [{ knowledgeVectors: { ownerSupplement: false } }, asked, { warmUp: true, enabled: true, ownerSupplement: false, asked: true, named: true }],
    // Explicit values from 0.2.x configs still win.
    [{ knowledgeVectors: { enabled: true } }, {}, { warmUp: true, enabled: true, ownerSupplement: false, asked: false, named: false }],
    [{ knowledgeVectors: { enabled: true, ownerSupplement: true } }, asked, { warmUp: true, enabled: true, ownerSupplement: true, asked: true, named: true }],
    [{ knowledgeVectors: { ownerSupplement: true } }, {}, { warmUp: false, enabled: false, ownerSupplement: false, asked: false, named: false }],
    [{ warmUp: true }, {}, { warmUp: true, enabled: false, ownerSupplement: false, asked: false, named: false }],
    // Knowledge names this plugin but does not hold the memory slot (unset means memory-core):
    // the host disables Knowledge, so nothing turns on by default.
    [undefined, knowledgeConfig({ slot: "memory-core" }), { warmUp: false, enabled: false, ownerSupplement: false, asked: false, named: true }],
    [undefined, knowledgeConfig({ slot: null }), { warmUp: false, enabled: false, ownerSupplement: false, asked: false, named: true }],
  ];
  for (const [pluginConfig, config, expected] of cases) {
    assert.deepEqual(resolveSettings(pluginConfig, config), expected, JSON.stringify([pluginConfig, config]));
  }
});

test("wiring hints name the missing setting, and say nothing for a complete setup", () => {
  assert.deepEqual(wiringHints(resolveSettings(undefined, knowledgeConfig()), knowledgeConfig()), []);
  assert.deepEqual(wiringHints(resolveSettings(undefined, {}), {}), []);
  const [notAsked] = wiringHints(resolveSettings({ knowledgeVectors: { enabled: true, ownerSupplement: true } }, knowledgeConfig({ ownerSearch: { enabled: true } })), knowledgeConfig({ ownerSearch: { enabled: true } }));
  assert.match(notAsked, /plugins\.entries\.knowledge\.config\.ownerSearch\.vectors\.plugin to "knowledge-embeddings"/);
  const [off] = wiringHints(resolveSettings({ knowledgeVectors: { enabled: false } }, knowledgeConfig()), knowledgeConfig());
  assert.match(off, /knowledgeVectors\.enabled is false/);
  const [noSupplement] = wiringHints(resolveSettings({ knowledgeVectors: { ownerSupplement: false } }, knowledgeConfig()), knowledgeConfig());
  assert.match(noSupplement, /knowledgeVectors\.ownerSupplement is false/);
  const slotHint = 'Knowledge vectors answer only while Knowledge holds the memory slot (plugins.slots.memory: "knowledge").';
  for (const wrongSlot of [knowledgeConfig({ slot: "memory-core" }), knowledgeConfig({ slot: null })]) {
    assert.deepEqual(wiringHints(resolveSettings(undefined, wrongSlot), wrongSlot), [slotHint]);
    // Explicitly on, outside the slot: only the slot is missing.
    assert.deepEqual(wiringHints(resolveSettings({ knowledgeVectors: { enabled: true, ownerSupplement: true } }, wrongSlot), wrongSlot), [slotHint]);
  }
  // Knowledge names this plugin, but its owner search is off.
  const searchOff = knowledgeConfig({ ownerSearch: { vectors: { plugin: "knowledge-embeddings" } } });
  assert.deepEqual(wiringHints(resolveSettings(undefined, searchOff), searchOff), [
    "Knowledge names knowledge-embeddings for owner search vectors, but its owner search is off. Set plugins.entries.knowledge.config.ownerSearch.enabled to true.",
  ]);
});

test("outside the Knowledge slot, Knowledge naming this plugin opens no index and does not warm up, but the log says why", async () => {
  for (const slot of ["memory-core", null]) {
    const config = knowledgeConfig({ slot });
    const h = host(undefined, { config });
    assert.deepEqual([h.services.length, h.supplements.length], [1, 0]);
    await h.services[0].start();
    await settle();
    assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), false);
    assert.deepEqual(h.queries, []);
    assert.deepEqual(h.warnings, ['knowledge-embeddings: Knowledge vectors answer only while Knowledge holds the memory slot (plugins.slots.memory: "knowledge").']);
    await h.services[0].stop();
  }
});

test("Knowledge naming this plugin with its owner search off logs which setting is missing", async () => {
  const config = knowledgeConfig({ ownerSearch: { vectors: { plugin: "knowledge-embeddings" } } });
  const h = host(undefined, { config });
  assert.equal(h.services.length, 1);
  await h.services[0].start();
  await settle();
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /ownerSearch\.enabled to true/);
  await h.services[0].stop();
});

test("Knowledge naming this plugin alone turns on the index, the supplement and warm-up", async () => {
  const h = host(undefined, { config: knowledgeConfig() });
  assert.deepEqual([h.services.length, h.supplements.length], [1, 1]);
  await h.services[0].start();
  let out = [];
  for (let i = 0; i < 40 && !out.length; i++) {
    await settle();
    out = await h.supplements[0].search({ query: "court", maxResults: 5 });
  }
  assert.equal(out[0]?.path, `${VAULT}/private/c1`);
  assert.deepEqual(h.queries[0], ["warm-up", "query"]);
  assert.deepEqual(h.warnings, []);
  await h.services[0].stop();
});

test("an explicit knowledgeVectors.enabled false wins over Knowledge, and the log says so", async () => {
  const h = host({ warmUp: false, knowledgeVectors: { enabled: false } }, { config: knowledgeConfig() });
  assert.deepEqual([h.services.length, h.supplements.length], [1, 0]);
  await h.services[0].start();
  await settle();
  assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), false);
  assert.deepEqual(h.queries, []);
  assert.equal(h.warnings.length, 1);
  assert.match(h.warnings[0], /^knowledge-embeddings: Knowledge's owner search asks knowledge-embeddings for vectors, but knowledgeVectors\.enabled is false/);
  await h.services[0].stop();
});

test("memory search on Harrier warms up by default, with no Knowledge index", async () => {
  const h = host(undefined, { config: { memory: { search: { provider: "harrier-local" } } } });
  assert.deepEqual([h.services.length, h.supplements.length], [1, 0]);
  await h.services[0].start();
  await settle();
  assert.deepEqual(h.queries, [["warm-up", "query"]]);
  assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), false);
});

test("registration with a bare API (no config, no runtime) registers nothing and does not throw", () => {
  for (const pluginConfig of [undefined, {}]) {
    const calls = [];
    const api = { pluginConfig, registerService: (s) => calls.push(s), registerMemoryCorpusSupplement: (s) => calls.push(s) };
    registerKnowledgeVectors(api, { create: async () => assert.fail("no embed at register") });
    assert.deepEqual(calls, []);
  }
});

// An index whose DB is failing (full, read-only, corrupt): reindex rejects, and so may logEvent.
const brokenIndex = ({ logEventThrows = true } = {}) => {
  const calls = { reindex: 0, events: [] };
  return {
    calls,
    createIndex: () => ({
      reindex: async () => {
        calls.reindex++;
        throw new Error("database or disk is full");
      },
      logEvent: (kind) => {
        if (logEventThrows) throw new Error("database or disk is full");
        calls.events.push(kind);
      },
      close: async () => {},
    }),
  };
};

test("a reindex failure whose event log also fails does not reject unhandled", async () => {
  const unhandled = [];
  const spy = (e) => unhandled.push(e);
  process.on("unhandledRejection", spy);
  try {
    const broken = brokenIndex();
    const h = host({ knowledgeVectors: { enabled: true, intervalMs: 0 } }, { createIndex: broken.createIndex });
    await h.services[0].start();
    await settle();
    assert.equal(broken.calls.reindex, 1);
    assert.deepEqual(unhandled, []);
    await h.services[0].stop();
  } finally {
    process.off("unhandledRejection", spy);
  }
});

test("a persistent reindex failure warns once, not every pass", async () => {
  const broken = brokenIndex({ logEventThrows: false });
  const h = host({ knowledgeVectors: { enabled: true, intervalMs: 5 } }, { createIndex: broken.createIndex });
  await h.services[0].start();
  await settle();
  await h.services[0].stop();
  assert.ok(broken.calls.reindex > 2);
  assert.deepEqual(h.warnings, ["knowledge-embeddings knowledge vectors reindex failed: database or disk is full"]);
  assert.deepEqual(broken.calls.events, ["reindex-error"]);
});

// fs.watch stand-in: records every watch; emit(dir, name) reaches the watcher on dir.
function fakeWatch({ throws } = {}) {
  const handles = [];
  const watch = (dir, opts, listener) => {
    if (throws) throw throws;
    const h = Object.assign(new EventEmitter(), { dir, listener, closed: false, close: () => (h.closed = true) });
    handles.push(h);
    return h;
  };
  const emit = (dir, name) => handles.filter((h) => h.dir === dir && !h.closed).forEach((h) => h.listener("rename", name));
  return { watch, handles, emit };
}
// reindex resolves at once, or when release() is called if gated.
const countingIndex = ({ gated = false } = {}) => {
  const calls = { reindex: 0, close: 0, open: 0 };
  let release = () => {};
  return {
    calls,
    release: () => release(),
    createIndex: () => (calls.open++, {
      reindex: async () => {
        calls.reindex++;
        if (gated) await new Promise((r) => (release = r));
        return {};
      },
      logEvent() {},
      close: async () => {
        calls.close++;
      },
    }),
  };
};
const intervalsOf = (spy) => spy.mock.calls.map((c) => c.arguments[1]);
const emfile = Object.assign(new Error("too many open files"), { code: "EMFILE" });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("watching polls every 5 minutes; with watch off, or once watching fails, every 30 s", async (t) => {
  const cases = [
    [{}, {}, [WATCH_POLL_MS]],
    [{ watch: false }, {}, [POLL_MS]],
    [{}, { throws: emfile }, [WATCH_POLL_MS, POLL_MS]],
    [{ intervalMs: 60_000 }, { throws: emfile }, [60_000, 60_000]],
  ];
  for (const [kv, watchOpts, expected] of cases) {
    const spy = t.mock.method(globalThis, "setInterval");
    const w = fakeWatch(watchOpts);
    const idx = countingIndex();
    const h = host({ knowledgeVectors: { enabled: true, ...kv } }, { createIndex: idx.createIndex, watch: w.watch });
    await h.services[0].start();
    await settle();
    assert.deepEqual(intervalsOf(spy), expected, JSON.stringify(kv));
    if (watchOpts.throws) {
      assert.equal(h.warnings.length, 1);
      assert.match(h.warnings[0], /watching Knowledge stores failed \(EMFILE\); polling every (30|60) s instead/);
    } else {
      assert.deepEqual(h.warnings, []);
      // stores root, vault, private, private/claims
      assert.equal(w.handles.length, kv.watch === false ? 0 : 4);
    }
    await h.services[0].stop();
    spy.mock.restore();
  }
});

test("a watcher error later falls back to polling once and reindexes what it may have missed", async (t) => {
  const spy = t.mock.method(globalThis, "setInterval");
  const w = fakeWatch();
  const idx = countingIndex();
  const h = host({ knowledgeVectors: { enabled: true, watchDebounceMs: 10 } }, { createIndex: idx.createIndex, watch: w.watch });
  await h.services[0].start();
  await settle();
  // The start pass, and one for changes made while the watchers were being set up.
  assert.equal(idx.calls.reindex, 2);
  w.handles[0].emit("error", emfile);
  w.handles[1].emit("error", emfile);
  await settle();
  assert.equal(h.warnings.length, 1);
  assert.ok(w.handles.every((x) => x.closed));
  assert.deepEqual(intervalsOf(spy), [WATCH_POLL_MS, POLL_MS]);
  assert.equal(idx.calls.reindex, 3);
  await h.services[0].stop();
});

test("changes debounce into one pass, and stop() cancels a pending one and closes every watcher", async () => {
  const w = fakeWatch();
  const idx = countingIndex();
  const h = host({ knowledgeVectors: { enabled: true, watchDebounceMs: 30 } }, { createIndex: idx.createIndex, watch: w.watch });
  await h.services[0].start();
  await settle();
  assert.equal(idx.calls.reindex, 2);
  for (const name of ["c2.md", "c3.md", "c4.md"]) w.emit(h.claims, name);
  await settle();
  assert.equal(idx.calls.reindex, 3);
  // Irrelevant names never schedule a pass.
  w.emit(h.claims, ".c2.md.swp");
  w.emit(h.claims, "c2.md.tmp");
  await settle();
  assert.equal(idx.calls.reindex, 3);

  w.emit(h.claims, "c5.md");
  await h.services[0].stop();
  await wait(80);
  assert.equal(idx.calls.reindex, 3);
  assert.ok(w.handles.length > 0 && w.handles.every((x) => x.closed));
});

test("stop() waits for the pass in flight, and a second start replaces the first", async (t) => {
  const spy = t.mock.method(globalThis, "setInterval");
  const clears = t.mock.method(globalThis, "clearInterval");
  const w = fakeWatch();
  const idx = countingIndex({ gated: true });
  const h = host({ knowledgeVectors: { enabled: true, watchDebounceMs: 10 } }, { createIndex: idx.createIndex, watch: w.watch });
  await h.services[0].start();
  await settle();
  assert.equal(idx.calls.reindex, 1);
  let stopped = false;
  const stopping = h.services[0].stop().then(() => (stopped = true));
  await settle();
  assert.equal(stopped, false);
  idx.release();
  await stopping;
  assert.equal(idx.calls.close, 1);

  await h.services[0].start();
  const first = w.handles.length, timer = spy.mock.calls.at(-1).result;
  const second = h.services[0].start();
  await settle();
  idx.release();
  await second;
  await settle();
  // The first start's watchers, timer and index are gone; only the second's remain.
  assert.ok(w.handles.slice(0, first).every((x) => x.closed));
  assert.ok(w.handles.slice(first).every((x) => !x.closed));
  assert.ok(clears.mock.calls.some((c) => c.arguments[0] === timer));
  assert.equal(idx.calls.close, 2);
  idx.release();
  await h.services[0].stop();
});

test("a start and a stop that overlap while a pass is in flight leave nothing open", async () => {
  const w = fakeWatch();
  const idx = countingIndex({ gated: true });
  const h = host({ knowledgeVectors: { enabled: true, watchDebounceMs: 10 } }, { createIndex: idx.createIndex, watch: w.watch });
  await h.services[0].start();
  await settle();
  // Neither is awaited: the start waits for the gated pass, and the stop comes after it.
  const starting = h.services[0].start();
  const stopping = h.services[0].stop();
  await settle();
  idx.release();
  await Promise.all([starting, stopping]);
  await settle();
  assert.equal(idx.calls.open, idx.calls.close);
  assert.ok(w.handles.every((x) => x.closed));
});

test("the safety poll also rescans, so a directory whose event was lost is watched", async () => {
  const w = fakeWatch();
  const idx = countingIndex();
  const h = host({ knowledgeVectors: { enabled: true, intervalMs: 40, watchDebounceMs: 10 } }, { createIndex: idx.createIndex, watch: w.watch });
  await h.services[0].start();
  await settle();
  // The fake never emits: only the poll can find this.
  const late = path.join(h.claims, "late");
  fs.mkdirSync(late);
  assert.ok(await (async () => {
    for (let i = 0; i < 50; i++) {
      if (w.handles.some((x) => x.dir === late && !x.closed)) return true;
      await wait(10);
    }
    return false;
  })());
  await h.services[0].stop();
});

test("writing a record file reindexes it within the debounce window, once", async () => {
  const DEBOUNCE = 100;
  let passes = 0;
  const createIndex = (o) => {
    const vi = createVectorIndex(o);
    return { ...vi, reindex: (...a) => (passes++, vi.reindex(...a)) };
  };
  const h = host({ knowledgeVectors: { enabled: true, ownerSupplement: true, intervalMs: 0, watchDebounceMs: DEBOUNCE } }, { createIndex });
  const [supplement] = h.supplements;
  const search = (query) => supplement.search({ query, maxResults: 5 });
  await h.services[0].start();
  for (let i = 0; i < 40 && !(await search("court")).length; i++) await settle();
  assert.equal((await search("court")).length, 1);
  // The start pass, and one after the watchers are up. Their own DB writes and reads
  // must not schedule more.
  await wait(DEBOUNCE * 3);
  assert.equal(passes, 2);

  const t0 = Date.now();
  fs.writeFileSync(
    path.join(h.claims, "c2.md"),
    "---\nformat: knowledge-record-v1\nid: c2\nrevision: 1\nkind: claim\ntitle: \"Jersey sizes\"\nlifecycle: active\n---\nJersey sizes for the team\n",
  );
  let out = [];
  while (!out.length && Date.now() - t0 < DEBOUNCE + 2000) {
    await wait(10);
    out = await search("jersey");
  }
  const elapsed = Date.now() - t0;
  assert.deepEqual(out.map((o) => o.path), [`${VAULT}/private/c2`]);
  assert.ok(elapsed >= DEBOUNCE - 10, `indexed after ${elapsed} ms, before the debounce`);
  await wait(DEBOUNCE * 3);
  assert.equal(passes, 3);
  await h.services[0].stop();
});

// A config written for 0.2.x, when the plugin id was harrier-local. The embedding provider id
// (memory.search.provider) is still harrier-local and needs no change.
const legacyConfig = (harrierConfig = { warmUp: false, knowledgeVectors: { batchSize: 4 } }) => ({
  plugins: {
    allow: ["knowledge", "harrier-local", "llama-cpp"],
    slots: { memory: "knowledge" },
    entries: {
      "harrier-local": { enabled: true, ...(harrierConfig ? { config: harrierConfig } : {}) },
      knowledge: { config: { ownerSearch: { enabled: true, vectors: { plugin: "harrier-local" } } } },
    },
  },
  memory: { search: { provider: "harrier-local" } },
});

test("settings under the old plugin id are used until settings exist under the new one", () => {
  const legacy = { warmUp: false };
  assert.equal(pluginSettings(undefined, { plugins: { entries: { "harrier-local": { config: legacy } } } }), legacy);
  // The host fills the new entry's settings with schema defaults; the old entry still wins while the new one is unset.
  assert.equal(pluginSettings({ knowledgeVectors: {} }, { plugins: { entries: { "harrier-local": { config: legacy } } } }), legacy);
  const current = { warmUp: true };
  assert.equal(
    pluginSettings(current, { plugins: { entries: { "harrier-local": { config: legacy }, "knowledge-embeddings": { config: current } } } }),
    current,
  );
  assert.equal(pluginSettings(current, { plugins: { entries: { "harrier-local": { enabled: true } } } }), current);
  assert.equal(pluginSettings(current, undefined), current);
});

test("every config place that names the old id gets the exact command that moves it", () => {
  assert.deepEqual(migrationHints(knowledgeConfig()), []);
  assert.deepEqual(migrationHints({ memory: { search: { provider: "harrier-local" } } }), []);
  assert.deepEqual(migrationHints(legacyConfig()), [
    "harrier-local is now knowledge-embeddings: plugins.entries.harrier-local holds its settings, used until they move. " +
      `Run: openclaw config set plugins.entries.knowledge-embeddings.config '{"warmUp":false,"knowledgeVectors":{"batchSize":4}}' --strict-json && openclaw config unset plugins.entries.harrier-local`,
    `harrier-local is now knowledge-embeddings: plugins.allow names the old id. Run: openclaw config set plugins.allow '["knowledge","knowledge-embeddings","llama-cpp"]' --strict-json`,
    "harrier-local is now knowledge-embeddings: Knowledge's owner search asks for vectors from the old id, so it gets keyword results only. " +
      "Run: openclaw config set plugins.entries.knowledge.config.ownerSearch.vectors.plugin knowledge-embeddings",
  ]);
  // An entry without settings only needs removing; a deny list is renamed like allow.
  const bare = { plugins: { deny: ["harrier-local"], entries: { "harrier-local": { enabled: false } } } };
  assert.deepEqual(migrationHints(bare), [
    "harrier-local is now knowledge-embeddings: plugins.entries.harrier-local is left over. Run: openclaw config unset plugins.entries.harrier-local",
    `harrier-local is now knowledge-embeddings: plugins.deny names the old id. Run: openclaw config set plugins.deny '["knowledge-embeddings"]' --strict-json`,
  ]);
});

test("the settings in a migration command survive the shell exactly, quotes included", { skip: process.platform === "win32" && "needs bash" }, () => {
  const settings = { knowledgeVectors: { note: "it's \"quoted\" $HOME `x`" } };
  const [hint] = migrationHints({ plugins: { entries: { "harrier-local": { config: settings } } } });
  const arg = hint.match(/config set plugins\.entries\.knowledge-embeddings\.config (.*) --strict-json/)[1];
  assert.deepEqual(JSON.parse(execFileSync("bash", ["-c", `printf %s ${arg}`], { encoding: "utf8" })), settings);
});

test("a 0.2.x config keeps working under the new id, and the log says how to migrate it", async () => {
  const config = legacyConfig({ warmUp: true, knowledgeVectors: { enabled: true, intervalMs: 0 } });
  const h = host(undefined, { config });
  // The old entry's settings apply: index on (enabled true), warm-up on.
  assert.equal(h.services.length, 1);
  await h.services[0].start();
  await settle();
  assert.deepEqual(h.queries[0], ["warm-up", "query"]);
  assert.equal(fs.existsSync(path.join(h.stateDir, KNOWLEDGE_VECTORS_DB)), true);
  // The store stays where 0.2.x put it.
  assert.equal(KNOWLEDGE_VECTORS_DB, path.join("harrier-local", "knowledge-vectors.sqlite"));
  const migration = h.warnings.filter((w) => w.startsWith("knowledge-embeddings: harrier-local is now knowledge-embeddings"));
  assert.equal(migration.length, 3);
  // Knowledge still names the old id, so it is not counted as asking, and no other hint repeats that.
  assert.equal(h.warnings.some((w) => /does not use them/.test(w)), false);
  await h.services[0].stop();

  // Settings under the old id that turn everything off still register a service, for the hints.
  const quiet = host(undefined, { config: legacyConfig() });
  assert.equal(quiet.services.length, 1);
  await quiet.services[0].start();
  await settle();
  assert.deepEqual(quiet.queries, []);
  assert.equal(quiet.warnings.length, 3);
  await quiet.services[0].stop();
});

test("Knowledge naming the old id does not turn the index on", () => {
  const config = knowledgeConfig({ ownerSearch: { enabled: true, vectors: { plugin: "harrier-local" } } });
  assert.equal(knowledgeAsksForVectors(config), false);
  assert.deepEqual(resolveSettings(undefined, config), { warmUp: false, enabled: false, ownerSupplement: false, asked: false, named: false });
});
