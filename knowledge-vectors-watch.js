// Push updates for the Knowledge vectors index: a debounced, coalescing reindex scheduler
// and a watcher over Knowledge's documented on-disk layout (read-only).
//
// Every watch is non-recursive, one per directory. Node's recursive watch on Linux walks
// the tree in JS and throws an uncaught exception (no 'error' event) when a new
// subdirectory cannot be watched (EACCES, ENOSPC), which would take the Gateway down.
// The watcher never watches a store as a whole either: each store holds its own
// state.sqlite and a vault/.git that Knowledge commits to on every checkpoint. Watched:
//   <state>/knowledge/stores                  stores appearing or going
//   <store>/vault (or <store> until it exists) private/, conversations/, vault.json
//   every directory under <vault>/private and <vault>/conversations that enumerateRecords
//   reads (no dot directories, no artifacts/)  the record files themselves
// and, while the stores root is missing, its nearest existing ancestor up to the state dir.
import fs from "node:fs";
import path from "node:path";

/**
 * Runs `run` at most once at a time. request() debounces; now() starts a pass at once.
 * A request or now() during a pass runs exactly one more pass after it. After stop(),
 * nothing runs again.
 */
export function createReindexScheduler({ run, debounceMs = 2000, timers = globalThis }) {
  let timer, running = false, again = false, stopped = false, current = Promise.resolve();
  const clear = () => {
    if (timer !== undefined) timers.clearTimeout(timer);
    timer = undefined;
  };
  const now = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    // This pass reads everything a pending debounce would have, so it replaces it.
    clear();
    running = true;
    current = (async () => {
      try {
        do {
          again = false;
          // This pass also reads what a debounce armed during the last one was waiting for.
          clear();
          try {
            await run();
          } catch {}
        } while (again && !stopped);
      } finally {
        running = false;
      }
    })();
  };
  return {
    request() {
      if (stopped) return;
      clear();
      timer = timers.setTimeout(() => {
        timer = undefined;
        now();
      }, debounceMs);
      timer?.unref?.();
    },
    now,
    stop() {
      stopped = true;
      again = false;
      clear();
    },
    /** Resolves when the pass in flight (if any) has finished. */
    idle: () => current,
    get running() {
      return running;
    },
  };
}

// Files Knowledge or its tools write beside records that never hold one.
const IGNORED_FILE = /(\.(tmp|temp|lock|swp|swo|bak|part|sqlite|db)|-(journal|wal|shm)|~)$|^(\.#|#)/i;

/** Whether a change under a partition root (`rel` relative to it) can change what the index reads. */
export function isRelevantChange(rel) {
  // No name (the watched directory itself went, or the platform gave none): assume it matters.
  if (!rel) return true;
  const segs = String(rel).split(/[\\/]+/).filter(Boolean);
  if (!segs.length) return true;
  // enumerateRecords skips dot directories (.git) and artifacts/; it only reads *.md.
  if (segs.some((s) => s.startsWith(".") || s === "artifacts")) return false;
  const base = segs.at(-1);
  if (IGNORED_FILE.test(base)) return false;
  const ext = path.extname(base);
  // A name without an extension is most likely a directory moving in or out.
  return ext === ".md" || ext === "";
}

/** Whether `name` in a record directory could be a directory that enumerateRecords reads. */
const mayBeDirectory = (name) => !name.startsWith(".") && name !== "artifacts" && !IGNORED_FILE.test(name) && path.extname(name) !== ".md";

// Only a path that is not there is "missing"; EACCES, EMFILE and the rest reach fail().
const isMissing = (e) => e?.code === "ENOENT" || e?.code === "ENOTDIR";

async function dirStat(p) {
  try {
    const st = await fs.promises.stat(p, { bigint: true });
    return st.isDirectory() ? st : undefined;
  } catch (e) {
    if (isMissing(e)) return undefined;
    throw e;
  }
}

async function listDirs(p) {
  try {
    return (await fs.promises.readdir(p, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}

/** A refresh that keeps finding new directories stops here; the next event or poll goes on. */
const MAX_REFRESH_ROUNDS = 20;

/**
 * Watches Knowledge's stores under `stateDir` and calls onChange() for every change that can
 * alter the index. If a watch cannot be set up or errors (EMFILE, ENOSPC, EACCES), every
 * watcher closes and onFail(error) is called once; the caller falls back to polling.
 * refresh() rescans the layout and heals any watcher that went stale.
 */
export function watchKnowledgeStores({ stateDir, onChange, onFail, watch = fs.watch }) {
  const root = path.join(stateDir, "knowledge", "stores");
  // dir -> { w, dev, ino }
  const watchers = new Map();
  let closed = false, refreshing = false, refreshAgain = false, initial = true;

  const fail = (e) => {
    if (closed) return;
    close();
    try {
      onFail?.(e);
    } catch {}
  };
  const changed = () => {
    try {
      onChange();
    } catch {}
  };
  const structural = () => {
    changed();
    void refresh();
  };

  const drop = (dir) => {
    const entry = watchers.get(dir);
    watchers.delete(dir);
    try {
      entry?.w.close();
    } catch {}
  };

  // onEvent(name) decides what a change in `dir` means; the watched directory going
  // (deleted or renamed: 'rename' with its own name, or no name) is always structural.
  const open = (dir, st, onEvent) => {
    const self = path.basename(dir);
    const w = watch(dir, { persistent: false }, (_event, raw) => {
      if (closed || watchers.get(dir)?.w !== w) return;
      try {
        const name = raw == null ? "" : String(raw);
        if (!name || name === self) structural();
        else onEvent(name, dir);
      } catch (e) {
        fail(e);
      }
    });
    w.on?.("error", (e) => {
      if (closed || watchers.get(dir)?.w !== w) return;
      if (isMissing(e)) {
        drop(dir);
        structural();
        return;
      }
      fail(e);
    });
    watchers.set(dir, { w, dev: st.dev, ino: st.ino });
  };

  // Structural directories name exactly what they care about.
  const only = (wanted) => (name) => {
    if (wanted(name)) structural();
  };
  // Record directories: a record file is a change; anything else that may be a directory
  // (moved in or out, or created) also rescans.
  const records = (name, dir) => {
    if (isRelevantChange(name)) {
      if (path.extname(name) === ".md") changed();
      else structural();
      return;
    }
    // A name with another extension may still be a directory ("v1.0"), which enumerateRecords
    // reads. One already watched moved or went: its records changed. Otherwise rescan; a
    // directory found that way schedules a pass itself, and a plain file costs one scan.
    if (!mayBeDirectory(name)) return;
    if (watchers.has(path.join(dir, name))) structural();
    else void refresh();
  };

  // dir -> [stat, onEvent]
  async function desired() {
    const want = new Map();
    const add = async (dir, onEvent) => {
      const st = await dirStat(dir);
      if (st) want.set(dir, [st, onEvent]);
      return st;
    };
    // Every directory under a partition that enumerateRecords' walk would read.
    const tree = async (dir) => {
      if (!(await add(dir, records))) return;
      for (const name of await listDirs(dir)) {
        if (name === "artifacts" || name.startsWith(".")) continue;
        await tree(path.join(dir, name));
      }
    };
    if (!(await dirStat(root))) {
      // Wait for the root to appear by watching the deepest ancestor that exists.
      for (const [dir, next] of [
        [path.join(stateDir, "knowledge"), "stores"],
        [stateDir, "knowledge"],
      ]) {
        if (await add(dir, only((n) => n === next))) break;
      }
      return want;
    }
    await add(root, only((n) => !IGNORED_FILE.test(n)));
    for (const s of await listDirs(root)) {
      const store = path.join(root, s), vault = path.join(store, "vault");
      if (!(await dirStat(vault))) {
        await add(store, only((n) => n === "vault"));
        continue;
      }
      await add(vault, only((n) => n === "private" || n === "conversations" || n === "vault.json"));
      await tree(path.join(vault, "private"));
      const conversations = path.join(vault, "conversations");
      // Each conversation directory is a partition, read whole, as enumerateRecords does.
      if (await add(conversations, only((n) => !IGNORED_FILE.test(n)))) {
        for (const sid of await listDirs(conversations)) await tree(path.join(conversations, sid));
      }
    }
    return want;
  }

  // Async discovery, one at a time; a refresh asked for during one runs once more after it.
  // A round that opens a watcher scans again: a directory made between the scan and the
  // watch on its parent would otherwise never be seen.
  async function refresh() {
    if (closed) return;
    if (refreshing) {
      refreshAgain = true;
      return;
    }
    refreshing = true;
    try {
      let rounds = 0;
      do {
        refreshAgain = false;
        const want = await desired();
        if (closed) return;
        for (const [dir, entry] of watchers) {
          const next = want.get(dir)?.[0];
          // Gone, or replaced at the same path: the old watch sees nothing any more.
          if (!next || next.dev !== entry.dev || next.ino !== entry.ino) drop(dir);
        }
        let opened = 0;
        for (const [dir, [st, onEvent]] of want) {
          if (closed) return;
          if (watchers.has(dir)) continue;
          try {
            open(dir, st, onEvent);
            opened++;
          } catch (e) {
            if (!isMissing(e)) throw e;
            // Went between the scan and the watch: the next round settles it.
            refreshAgain = true;
          }
        }
        if (opened) {
          refreshAgain = true;
          // Records may have landed before their directory was watched.
          if (!initial) changed();
        }
      } while (refreshAgain && !closed && ++rounds < MAX_REFRESH_ROUNDS);
    } catch (e) {
      fail(e);
    } finally {
      refreshing = false;
      initial = false;
    }
  }

  function close() {
    closed = true;
    for (const dir of [...watchers.keys()]) drop(dir);
  }

  const ready = refresh();
  return {
    close,
    refresh: () => refresh(),
    /** Resolves once the first discovery has set its watchers up (or failed). */
    ready: () => ready,
    get size() {
      return watchers.size;
    },
    /** The watched directories, for tests and diagnostics. */
    dirs: () => [...watchers.keys()],
  };
}
