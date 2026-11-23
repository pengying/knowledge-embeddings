# Changelog

## 0.3.0

- Renamed to **Knowledge Embeddings (Harrier)**: package `openclaw-plugin-knowledge-embeddings`, plugin id `knowledge-embeddings` (was `harrier-local`). The embedding provider keeps the id `harrier-local`, which names the model, so `memory.search.provider` and memory index identity are unchanged, and the Knowledge vectors store stays in `<state>/harrier-local/`. The manifest declares `legacyPluginIds: ["harrier-local"]`. Config under the old plugin id has to move: see [Upgrading from 0.2.x](#upgrading-from-02x).
- The package is no longer `private`, declares its published `files`, Node engine, ClawHub/npm install specs, OpenClaw `compat`/`build` versions and its repository.
- One setting turns on Knowledge vectors: Knowledge's `ownerSearch.vectors.plugin: "knowledge-embeddings"` (with `ownerSearch.enabled`, while `plugins.slots.memory` is `"knowledge"`). `knowledgeVectors.enabled` and `knowledgeVectors.ownerSupplement` now default to it; the plugin only reads Knowledge's config. Explicit values in its own config still win. One 0.2.x config changes meaning: `knowledgeVectors.enabled: true` with `ownerSupplement` omitted was index-only, and now also serves owner search when Knowledge asks for it. Set `ownerSupplement: false` to stay index-only.
- Outside the Knowledge memory slot (another plugin, or unset, which means memory-core), Knowledge naming this plugin no longer turns on the index, its watchers or warm-up. The host disables Knowledge there, so they only cost memory and CPU. The slot hint is still logged.
- `warmUp` defaults on while Harrier is in use (`memory.search.provider: "harrier-local"`, globally or for an agent, with agent fields overriding the top-level ones as in core, or the Knowledge index is on) and off otherwise.
- A half-wired Knowledge setup logs one plain hint at service start naming the setting to change, including Knowledge naming this plugin with `ownerSearch.enabled` unset.
- Without OpenClaw's managed llama.cpp server, Harrier now says what to run (install `@openclaw/llama-cpp-provider`, embedding-only setup pointed at Harrier's GGUF, select `harrier-local`) instead of `models.providers.llama-cpp.localService must be a non-null object ...`. A missing or disabled llama-cpp plugin gets its own message.
- A Knowledge record that never embeds no longer fails the whole reindex pass. After three failures in a row, one short probe embed decides: if it works, those records are skipped (logged once as `embed-failed`, retried next pass) and the pass goes on; only a failing probe aborts it as llama.cpp being down. An aborted pass still records its events and prunes the table.
- Long records are embedded whole, in chunks, instead of cut at 6,000 characters (dense CJK could exceed the managed server's 2,048-token context on every attempt). A body over an estimated 1,800 tokens is split at paragraph, line, sentence or word breaks into chunks that overlap by about 100 tokens, each led by the record's title and aliases, and every chunk is embedded. The index keeps one row per chunk; a record scores as its best chunk and is proposed once. A chunk that never embeds is skipped and retried like a record, while the record's other chunks are stored and searchable.
- The vectors store moves to schema 2 (one row per chunk). The migration keeps every row as chunk 0 and the next pass looks at each record once: unchanged text comes from the embed cache, and records that were cut short are re-embedded in chunks.
- A `models.providers.llama-cpp` config without a managed `localService` (a llama-server you run yourself) now gets its own message: remove that config first (`openclaw config unset models.providers.llama-cpp`), then run the setup. Before, Harrier said llama.cpp was "not set up yet" and suggested setup commands that OpenClaw then refused ("cannot replace an existing llama.cpp server"). A missing `baseUrl` lists the full setup, not just the onboard step.
- Record frontmatter is read the way Knowledge writes it. Knowledge's yaml writer folds values longer than 80 columns onto continuation lines, and Harrier kept only the first line, so long titles, aliases and attributions were cut short (and a folded quoted value kept a stray `"`). Folded, quoted, escaped and block-scalar (`|`, `>`) values now read whole, and CRLF line endings, a BOM and a frontmatter closed at the end of the file are accepted, as Knowledge's own reader accepts them. Records whose text changes this way are re-embedded once.
- A record whose `revision` is missing or not a positive integer has an unknown revision: an active copy of a withdrawn record with no revision stays blocked by its tombstone, instead of clearing it.
- A Knowledge directory or record that exists but cannot be read (EACCES, EMFILE) keeps its vectors for the pass instead of being pruned, and the log says how many paths could not be read. Only a missing path counts as deleted. An unreadable stores root or `vault.json` fails the pass without pruning.
- A new directory with a dot in its name (`v1.0`) under a partition is watched as soon as it appears, instead of at the next safety poll (never with `intervalMs: 0`).
- Registration no longer touches runtime helpers, so a narrower discovery API cannot make it throw.
- Checked that the pinned `hf:` model downloads and verifies from an empty cache through OpenClaw 2026.11.5's llama.cpp provider (see docs/development.md).
- Removed the stale `patch:openclaw-memory-search-maintenance` script entry (its script was retired with OpenClaw 2026.8.1).

### Upgrading from 0.2.x

OpenClaw reads a plugin's settings, allowlist and Knowledge's vector plugin by exact plugin id, and `legacyPluginIds` does not change that for a third-party plugin. So config that names the old plugin id `harrier-local` has to move. `memory.search.provider: "harrier-local"` (global or per agent) stays: that is the embedding provider id. Until the settings move, the plugin reads them from `plugins.entries.harrier-local.config` and logs, at service start, the exact `openclaw config` command for each place that still names the old id.

On the Gateway host:

```sh
# 1. Print the old settings, to copy in step 4 (an error here means there are none).
openclaw config get plugins.entries.harrier-local.config --json
# 2. Remove the old plugin. This also removes its settings entry, allowlist entry, install
#    record and load path. memory.search and the vectors index (<state>/harrier-local) stay.
openclaw plugins uninstall harrier-local
# 3. Install the new one.
openclaw plugins install openclaw-plugin-knowledge-embeddings
# 4. Only if step 1 printed settings: put them back under the new id.
openclaw config set plugins.entries.knowledge-embeddings.config '<what step 1 printed>' --strict-json
# 5. Only if you use plugins.allow: make sure it lists knowledge-embeddings.
openclaw config get plugins.allow --json
# 6. Only if Knowledge's owner search used these vectors:
openclaw config set plugins.entries.knowledge.config.ownerSearch.vectors.plugin knowledge-embeddings
# 7. Restart the Gateway (wait for running sessions first).
openclaw gateway restart
```

If you replace the plugin files in place instead of reinstalling, the old config entries stay. The plugin then uses them and logs the commands above, but only if it loads: with `plugins.allow` set, add `knowledge-embeddings` to it first.

## 0.2.3

Watcher hardening. Every watch is non-recursive, one per directory: on Linux, Node's recursive watch throws an uncaught exception (which would stop the Gateway) when a new subdirectory cannot be watched. Any watch or scan error other than a missing path (EACCES, EMFILE, ENOSPC) falls back to polling. A directory made while its parent's watch is being set up, a watched directory renamed away, and a directory swapped for a new one at the same path are all picked up, and the safety poll also rescans the watched directories, so a stale watcher heals within one poll. One more pass runs once the watchers are up, to cover changes made while they were being set up. A second start replaces the first, and stop waits for the pass in flight.

## 0.2.2

The index updates on push instead of only on a 30 s poll. With `knowledgeVectors.watch` (default `true`) the service watches Knowledge's stores read-only with `fs.watch`: the stores root and each `vault`, for stores and partitions appearing, and every directory under `vault/private` and `vault/conversations`, for the record files. It never watches `.git`, `state.sqlite` or a whole store, and ignores dot paths, `artifacts/`, non-`.md` files and temp, lock, swap and journal names, so Knowledge's Git checkpoints do not trigger passes. Changes are debounced (`watchDebounceMs`, default 2000) into one pass; passes never overlap, and a change during a pass runs exactly one more after it. While watching, `intervalMs` defaults to 300000 (a safety poll); with `watch: false`, or if a watch cannot be set up or errors (EMFILE, ENOSPC), it stays 30000, and the fallback is logged once. Stop closes every watcher and cancels a pending pass.

## 0.2.1

Index hardening: each record is stored as soon as it is embedded, a record that will not embed is skipped and retried next pass, a reindex failure is logged (`log.warn`, at most once per 10 minutes per message) and can no longer crash the Gateway, stop waits for at most the batch in flight, the same id in two partitions is proposed for each, and a pass that changes nothing writes no events (the table keeps the newest 10,000).

## 0.2.0

Opt-in Knowledge vectors and warm-up (both off by default in this release). With no plugin config, harrier-local registered only the embedding provider, exactly as before.

- `warmUp: true` embeds one query when the plugin service starts, so the first search after a Gateway restart does not pay the model load. Best effort: a failure is logged and the next search loads the model.
- `knowledgeVectors.enabled: true` keeps a vectors index of every Knowledge store and partition in `<state>/harrier-local/knowledge-vectors.sqlite`. It reads Knowledge's documented on-disk layout read-only, reindexes once at service start and then on a poll, and reuses an embed cache keyed by text hash, so a re-keyed partition costs no embeds.
- `knowledgeVectors.ownerSupplement: true` also offers the index to Knowledge's `knowledge_owner_search` through the memory corpus supplement registry, as ids and scores only. Knowledge validates every proposal with its own lookup and shows only its own text. It answers only while Knowledge holds the memory slot, because memory-core reads every supplement as its wiki corpus.

## 0.1.6

Dropped the `openclaw` peer dependency. OpenClaw's plugin loader supplies `openclaw/plugin-sdk` to plugin modules, so a `node_modules/openclaw` peer link is not needed; the link pinned each install to one host release path and had to be recreated after every OpenClaw upgrade. Verified loading without the link on OpenClaw 2026.11.5.

## 0.1.5

Supports the optional `queryInstructionApplied` contract. When OpenClaw has already applied an explicit query instruction or input format, Harrier preserves that prepared input instead of applying its default template again. Without that marker, existing query bytes are unchanged. The package declares the public SDK minimum `>=2026.9.8`, without an artificial upper cap.
