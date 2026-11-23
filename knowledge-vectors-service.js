// Wires the Harrier embedder to Knowledge's owner search and a startup warm-up.
//   warmUp                          one query embed when the service starts, so the first
//                                   search after a Gateway restart is not a cold load.
//                                   Default: on while Harrier is in use (memory search or
//                                   Knowledge vectors), off otherwise.
//   knowledgeVectors.enabled        keep the vectors index current from Knowledge's stores:
//                                   on change (watch, default on) and on a safety poll
//   knowledgeVectors.ownerSupplement
//                                   offer it to knowledge_owner_search (ids and scores only)
// Both Knowledge flags default to whether Knowledge's owner search asks for this plugin
// (plugins.entries.knowledge.config.ownerSearch.vectors.plugin) while Knowledge holds the
// memory slot, so that one Knowledge setting turns them on; an explicit value here always wins. The store lives in this
// plugin's own state directory and opens only when the service starts, never at plugin load.
//
// Until 0.3.0 the plugin id was harrier-local. Settings still under plugins.entries.harrier-local
// are used until they move, and every config place that names the old id gets a log line with
// the command that moves it.
import path from "node:path";
import { HARRIER_MODEL, HARRIER_PROVIDER_ID, LEGACY_PLUGIN_ID, PLUGIN_ID } from "./adapter.js";
import { createVectorIndex, ownerSupplement } from "./knowledge-vectors.js";
import { createReindexScheduler, watchKnowledgeStores } from "./knowledge-vectors-watch.js";

// The store keeps the directory it had under the old plugin id (backupResources names it too),
// so the index carries over a rename without being moved.
export const KNOWLEDGE_VECTORS_DB = path.join(LEGACY_PLUGIN_ID, "knowledge-vectors.sqlite");
/** The same reindex warning is logged at most this often. */
export const REINDEX_WARN_EVERY_MS = 10 * 60_000;
/** Safety poll while watching; the poll alone when watching is off or unavailable. */
export const WATCH_POLL_MS = 300_000;
export const POLL_MS = 30_000;
export const WATCH_DEBOUNCE_MS = 2_000;

const KNOWLEDGE_VECTORS_PATH = "plugins.entries.knowledge.config.ownerSearch.vectors.plugin";

const knowledgeVectorsPlugin = (config) => {
  const entry = config?.plugins?.entries?.knowledge;
  return entry?.enabled === false ? undefined : entry?.config?.ownerSearch?.vectors?.plugin;
};
/** Knowledge is not disabled and its owner search names this plugin for its vector leg. */
export function knowledgeNamesPlugin(config) {
  return knowledgeVectorsPlugin(config) === PLUGIN_ID;
}

const knowledgeHoldsSlot = (config) => config?.plugins?.slots?.memory === "knowledge";
const ownerSearchOn = (config) => config?.plugins?.entries?.knowledge?.config?.ownerSearch?.enabled === true;

/**
 * Knowledge would use vectors from this plugin: it holds the memory slot (the host disables
 * it otherwise, and an unset slot means memory-core), its owner search is on, and names this
 * plugin for its vector leg.
 */
export function knowledgeAsksForVectors(config) {
  return knowledgeNamesPlugin(config) && ownerSearchOn(config) && knowledgeHoldsSlot(config);
}

/**
 * Memory search uses Harrier, globally or for any agent. As in core, each agent's
 * memory.search fields override the top-level ones.
 */
export function memorySearchUsesHarrier(config) {
  const defaults = config?.memory?.search;
  const uses = (search) =>
    (search?.provider ?? defaults?.provider) === HARRIER_PROVIDER_ID && (search?.enabled ?? defaults?.enabled ?? true) !== false;
  const agents = Array.isArray(config?.agents?.list) ? config.agents.list : [];
  return uses(undefined) || agents.some((agent) => uses(agent?.memory?.search));
}

/** Effective switches: an explicit plugin setting wins, otherwise the defaults follow the config. */
export function resolveSettings(pluginConfig, config) {
  const pc = pluginConfig ?? {};
  const kv = pc.knowledgeVectors ?? {};
  const asked = knowledgeAsksForVectors(config);
  const enabled = typeof kv.enabled === "boolean" ? kv.enabled : asked;
  const ownerSupplement = enabled && (typeof kv.ownerSupplement === "boolean" ? kv.ownerSupplement : asked);
  const warmUp = typeof pc.warmUp === "boolean" ? pc.warmUp : enabled || memorySearchUsesHarrier(config);
  return { warmUp, enabled, ownerSupplement, asked, named: knowledgeNamesPlugin(config) };
}

/** Plain-language notes for a half-wired Knowledge setup, logged once at service start. */
export function wiringHints(settings, config) {
  const hints = [];
  const searchOn = ownerSearchOn(config);
  if (settings.asked && !settings.ownerSupplement) {
    hints.push(
      `Knowledge's owner search asks ${PLUGIN_ID} for vectors, but ${settings.enabled ? "knowledgeVectors.ownerSupplement" : "knowledgeVectors.enabled"} is false, ` +
        `so it answers with keyword results only. Remove that setting from plugins.entries.${PLUGIN_ID}.config to turn vectors on.`,
    );
  }
  if (settings.named && !searchOn) {
    hints.push(
      `Knowledge names ${PLUGIN_ID} for owner search vectors, but its owner search is off. ` +
        "Set plugins.entries.knowledge.config.ownerSearch.enabled to true.",
    );
  } else if (settings.ownerSupplement && !(settings.named && searchOn) && knowledgeVectorsPlugin(config) !== LEGACY_PLUGIN_ID) {
    // (Knowledge naming the old id gets its migration hint instead.)
    hints.push(
      `Knowledge vectors are on, but Knowledge's owner search does not use them. Set ${KNOWLEDGE_VECTORS_PATH} to "${PLUGIN_ID}" ` +
        "and plugins.entries.knowledge.config.ownerSearch.enabled to true.",
    );
  }
  if ((settings.ownerSupplement || settings.named) && !knowledgeHoldsSlot(config)) {
    hints.push('Knowledge vectors answer only while Knowledge holds the memory slot (plugins.slots.memory: "knowledge").');
  }
  return hints;
}

const shellQuote = (s) => `'${s.replace(/'/g, "'\\''")}'`;

/**
 * This plugin's settings: plugins.entries.knowledge-embeddings.config, or while that is unset,
 * the ones still under the old id. The host gives a plugin only its own entry.
 */
export function pluginSettings(pluginConfig, config) {
  const entries = config?.plugins?.entries;
  const legacy = entries?.[LEGACY_PLUGIN_ID]?.config;
  return entries?.[PLUGIN_ID]?.config === undefined && legacy !== undefined ? legacy : pluginConfig;
}

/** One log line, with the exact command, for each config place that still names the old id. */
export function migrationHints(config) {
  const hints = [];
  const renamed = `${LEGACY_PLUGIN_ID} is now ${PLUGIN_ID}`;
  const entries = config?.plugins?.entries;
  if (entries && Object.hasOwn(entries, LEGACY_PLUGIN_ID)) {
    const legacy = entries[LEGACY_PLUGIN_ID]?.config;
    const move =
      legacy !== undefined && entries[PLUGIN_ID]?.config === undefined
        ? `openclaw config set plugins.entries.${PLUGIN_ID}.config ${shellQuote(JSON.stringify(legacy))} --strict-json && `
        : "";
    hints.push(
      `${renamed}: plugins.entries.${LEGACY_PLUGIN_ID} ${move ? "holds its settings, used until they move" : "is left over"}. ` +
        `Run: ${move}openclaw config unset plugins.entries.${LEGACY_PLUGIN_ID}`,
    );
  }
  for (const list of ["allow", "deny"]) {
    const ids = config?.plugins?.[list];
    if (Array.isArray(ids) && ids.includes(LEGACY_PLUGIN_ID)) {
      const next = [...new Set(ids.map((id) => (id === LEGACY_PLUGIN_ID ? PLUGIN_ID : id)))];
      hints.push(`${renamed}: plugins.${list} names the old id. Run: openclaw config set plugins.${list} ${shellQuote(JSON.stringify(next))} --strict-json`);
    }
  }
  if (knowledgeVectorsPlugin(config) === LEGACY_PLUGIN_ID) {
    hints.push(
      `${renamed}: Knowledge's owner search asks for vectors from the old id, so it gets keyword results only. ` +
        `Run: openclaw config set ${KNOWLEDGE_VECTORS_PATH} ${PLUGIN_ID}`,
    );
  }
  return hints;
}

export function registerKnowledgeVectors(api, adapter, { createIndex = createVectorIndex, watch } = {}) {
  const config = () => api.runtime.config.current();
  // Registration must not depend on runtime helpers: discovery and setup load the entry with
  // a narrower API.
  const loaded = api.config ?? api.runtime?.config?.current?.();
  const pc = pluginSettings(api.pluginConfig, loaded);
  const kv = pc?.knowledgeVectors ?? {};
  const settings = resolveSettings(pc, loaded);
  const { warmUp, enabled } = settings;
  // A half-wired or not yet migrated setup still gets a service, so its hint reaches the log.
  if (!warmUp && !enabled && wiringHints(settings, loaded).length === 0 && migrationHints(loaded).length === 0) {
    return;
  }
  const log = api.logger ?? {};
  let providerP;
  const provider = () =>
    (providerP ??= adapter
      .create({
        config: config(),
        model: HARRIER_MODEL,
        acquireLocalService: api.runtime.llm?.acquireLocalService,
      })
      .then((result) => {
        if (!result.provider) {
          throw new Error(result.error ?? "Harrier returned no embedding provider.");
        }
        return result.provider;
      })
      .catch((e) => {
        providerP = undefined;
        throw e;
      }));
  const embedQuery = async (q) => (await provider()).embed(q, { inputType: "query" });
  const embedDocs = async (texts) => (await provider()).embedBatch(texts, { inputType: "document" });

  let index, timer, scheduler, watcher;
  if (settings.ownerSupplement) {
    // Silent until the service has opened the store, and whenever Knowledge does not hold
    // the memory slot (memory-core reads every supplement as its wiki corpus).
    const supplement = (vi) =>
      ownerSupplement(vi, {
        isKnowledgeSlot: () => knowledgeHoldsSlot(config()),
        floor: kv.vectorFloor ?? 0.3,
      });
    api.registerMemoryCorpusSupplement({
      search: (params) => (index ? supplement(index).search(params) : Promise.resolve([])),
      get: async () => null,
    });
  }

  // Closes the watchers and timers first, so nothing schedules a pass, then the index,
  // which ends the pass in flight at its next batch.
  async function teardown() {
    const s = scheduler;
    scheduler = undefined;
    s?.stop();
    watcher?.close();
    watcher = undefined;
    clearInterval(timer);
    timer = undefined;
    const vi = index;
    index = undefined;
    await Promise.all([vi?.close(), s?.idle()]);
  }

  // Each start and stop takes a generation; a start overtaken while it waited for the
  // teardown (by another start or a stop) opens nothing.
  let generation = 0;
  async function stop() {
    generation++;
    await teardown();
  }

  api.registerService({
    id: `${PLUGIN_ID}:knowledge-vectors`,
    start: async () => {
      // A second start replaces the first instead of leaking its watchers, timer and index.
      const own = ++generation;
      await teardown();
      if (own !== generation) return;
      for (const hint of [...migrationHints(config()), ...wiringHints(settings, config())]) {
        try {
          log.warn?.(`${PLUGIN_ID}: ${hint}`);
        } catch {}
      }
      if (warmUp) {
        const started = Date.now();
        // Best effort, never awaited: a failed warm-up leaves the first search to load the model.
        embedQuery("warm-up").then(
          () => log.info?.(`${PLUGIN_ID} warm-up: model loaded in ${Date.now() - started} ms`),
          (e) => log.warn?.(`${PLUGIN_ID} warm-up failed: ${e?.message ?? e}`),
        );
      }
      if (!enabled) {
        return;
      }
      const stateDir = api.runtime.state.resolveStateDir();
      index = createIndex({
        dbPath: path.join(stateDir, KNOWLEDGE_VECTORS_DB),
        stateDir,
        embedDocs,
        embedQuery,
        settings: {
          batchSize: kv.batchSize ?? 2,
          indexInactive: false,
        },
      });
      const vi = index;
      // Never rejects: the timer and start discard this promise, and the Gateway exits on an
      // unhandled rejection. A failing DB (full, read-only, corrupt) also fails logEvent.
      const warnedAt = new Map();
      const warn = (message, event) => {
        if (Date.now() - (warnedAt.get(message) ?? -Infinity) < REINDEX_WARN_EVERY_MS) return;
        warnedAt.set(message, Date.now());
        try {
          log.warn?.(message);
        } catch {}
        try {
          if (event) vi.logEvent("reindex-error", null, event);
        } catch {}
      };
      const reindex = () =>
        Promise.resolve()
          .then(() => vi.reindex())
          .then(
            (stats) => {
              if (stats?.failed) warn(`${PLUGIN_ID} knowledge vectors: ${stats.failed} record(s) failed to embed; retrying next pass`);
              if (stats?.unreadable) {
                warn(`${PLUGIN_ID} knowledge vectors: ${stats.unreadable} Knowledge path(s) could not be read; keeping their vectors until they can be`);
              }
            },
            (e) => {
              const error = String(e?.message ?? e);
              warn(`${PLUGIN_ID} knowledge vectors reindex failed: ${error}`, { error });
            },
          )
          .catch(() => {});
      scheduler = createReindexScheduler({ run: reindex, debounceMs: kv.watchDebounceMs ?? WATCH_DEBOUNCE_MS });
      const s = scheduler;
      // intervalMs 0: no poll, the start pass (and changes, while watching) only. The poll
      // also rescans the watched directories, so a watcher that went stale heals within one.
      const poll = (ms) => {
        clearInterval(timer);
        timer = undefined;
        if (ms === 0) return;
        timer = setInterval(() => {
          s.now();
          void watcher?.refresh();
        }, ms);
        timer.unref?.();
      };
      // One pass now; then on change, and on the poll.
      s.now();
      if (kv.watch === false) {
        poll(kv.intervalMs ?? POLL_MS);
        return;
      }
      poll(kv.intervalMs ?? WATCH_POLL_MS);
      const w = (watcher = watchKnowledgeStores({
        stateDir,
        watch,
        onChange: () => s.request(),
        onFail: (e) => {
          if (scheduler !== s) return;
          watcher = undefined;
          const ms = kv.intervalMs ?? POLL_MS;
          try {
            log.warn?.(
              `${PLUGIN_ID} knowledge vectors: watching Knowledge stores failed (${e?.code ?? e?.message ?? e}); ` +
                (ms ? `polling every ${ms / 1000} s instead` : "no poll is configured (intervalMs 0)"),
            );
          } catch {}
          poll(ms);
          // Changes may have gone unseen while the watch was failing.
          s.request();
        },
      }));
      // The start pass began before the watchers were set up: one more pass covers changes
      // made in between.
      w.ready().then(() => {
        if (watcher === w) s.request();
      });
    },
    stop,
  });
}
