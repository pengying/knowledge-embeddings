# Development notes

## Tests

```sh
npm test
```

runs every suite under `test/` with `node --test`. No suite loads personal configuration, starts a Gateway, requests model inference or downloads a model.

Two suites check a real OpenClaw host and are skipped unless pointed at one:

```sh
# Source checkout: the real host registry, plugin API, provider lookup and memory query owner,
# with a synthetic local transport.
OPENCLAW_COMPAT_SOURCE_DIR=/path/to/openclaw \
  node --import /path/to/openclaw/scripts/tsx.mjs --test test/candidate-sdk.test.js

# Built package: the actual public SDK and discovery comparator parser.
OPENCLAW_COMPAT_PACKAGE_DIR=/path/to/built/openclaw node --test test/openclaw-package.test.js
```

Run both against each OpenClaw release before deploying to it. `compat.pluginApi` is a floor (`>=2026.9.8`) without an upper cap, so ordinary upgrades reach qualification instead of being rejected by metadata alone. That is not a promise that every future SDK stays compatible. A post-deployment `openclaw memory search` is the separate live check.

## Model identity

`adapter.js` pins the GGUF source (`hf:` URI at a fixed commit) and its SHA-256. The index identity (`cacheKeyData`) covers the provider, model, quantization, dimensions, instruction version, source, hash and endpoint. Changing any of them rebuilds the memory index, so treat them as a migration.

The managed llama.cpp provider downloads the `hf:` source on first use (`ensureLlamaCppModel(..., download: true)` from the `local` embedding adapter). It resolves the file's LFS SHA-256 through Hugging Face's `paths-info` API at the pinned commit and verifies the download against it. At commit `5283b8a3…` that SHA-256 is `f97092bd…50b0`, the same as `HARRIER_GGUF_SHA256`. The cached file is `hf_SuperPauly_harrier-oss-v1-0.6b-gguf_<commit>_harrier-oss-v1-0.6B-Q8_0.gguf`.

Verified on 2026-11-23 against OpenClaw 2026.11.5 (`ba81527`): its built `ensureLlamaCppModel` (`dist/extensions/llama-cpp/.setup/managed-server-*.mjs`), called with `HARRIER_GGUF_SOURCE`, an empty cache directory, a temporary `HOME` and `OPENCLAW_STATE_DIR`, and `download: true`, fetched 639,447,872 bytes in about 24 s, and `sha256sum` of the result was `f97092bd…50b0` with a `GGUF` header. This checks the download step only, not a full clean-machine Gateway setup (llama-server install and first embedding). To repeat it for a new OpenClaw release:

```sh
mkdir -p /tmp/harrier-dl/{home,state,cache}
cat > /tmp/harrier-dl/check.mjs <<'JS'
const [chunk, adapter, cacheDir] = process.argv.slice(2);
const { ensureLlamaCppModel } = await import(chunk);
const { HARRIER_GGUF_SOURCE } = await import(adapter);
console.log(await ensureLlamaCppModel({ source: HARRIER_GGUF_SOURCE, cacheDir, download: true }));
JS
HOME=/tmp/harrier-dl/home OPENCLAW_STATE_DIR=/tmp/harrier-dl/state node /tmp/harrier-dl/check.mjs \
  "$(ls /path/to/openclaw/dist/extensions/llama-cpp/.setup/managed-server-*.mjs)" "$PWD/adapter.js" /tmp/harrier-dl/cache
sha256sum /tmp/harrier-dl/cache/*.gguf
rm -rf /tmp/harrier-dl
```

## Knowledge vectors store

The store is plugin-owned SQLite with its own ordered migration history (`schema_migrations`; schema 2: one `vectors` row per chunk of a record, keyed by vault, partition, record id and chunk). Each step commits with its history row in one transaction, a newer schema is refused unchanged, and the unversioned Design A spike layout is adopted in place. The manifest declares `<state>/harrier-local` in `backupResources` (`include`), so OpenClaw's WAL-aware backup takes managed snapshots of it. The index is derived data, but restoring it avoids re-embedding everything on the single llama.cpp slot after a restore.

A record that fits an estimated 1,800 tokens is one chunk, exactly the text earlier versions embedded. A longer body is split into overlapping chunks, each led by the record's header (`embedChunks`). The estimate is an upper bound for CJK, digits and punctuation (one token per UTF-8 byte); ASCII letters are counted at 0.6. A record's rows are replaced in one transaction once each chunk has embedded or failed. If some chunks failed, the rows are stored without the file hash, so the next pass takes the record up again and retries them.

Records are read from Knowledge's documented on-disk layout, read-only, because no SDK surface lists them. This is known debt carried over from the Design A spike.

## Switch resolution

`resolveSettings` in `knowledge-vectors-service.js` decides the three switches. An explicit boolean in `plugins.entries.knowledge-embeddings.config` wins (or, until it is set, in the old `plugins.entries.harrier-local.config`; see `pluginSettings`). Otherwise:

- `knowledgeVectors.enabled` and `knowledgeVectors.ownerSupplement` follow `knowledgeAsksForVectors`: Knowledge is not disabled, `plugins.slots.memory` is `"knowledge"` (the host disables Knowledge otherwise, and an unset slot means memory-core), `ownerSearch.enabled` is true, and `ownerSearch.vectors.plugin` is `knowledge-embeddings`.
- `warmUp` is on when the index is on, or when memory search uses `harrier-local` globally or for an agent in `agents.list`. An agent's `memory.search` fields override the top-level ones, as in core.

`wiringHints` logs one line at service start for each half-wired case: Knowledge names `knowledge-embeddings` but its owner search is off, or it does not hold the memory slot; vectors switched on in Harrier but not named by Knowledge; or Knowledge asks for vectors that Harrier's config switches off.

These switches have no `default` in the manifest schema on purpose. OpenClaw fills schema defaults into `pluginConfig`, which would make "unset" look like `false`.

## Ids

The plugin id is `knowledge-embeddings` (until 0.3.0, `harrier-local`). The embedding provider id stays `harrier-local`: it names the model, users select it in `memory.search.provider`, and it is part of the memory index identity. The vectors store stays in `<state>/harrier-local/`, which `backupResources` names. The manifest's `legacyPluginIds` lets OpenClaw map the old id where it resolves plugin ids from the registry (startup planning, npm install id checks). It does not cover the loader's per-plugin settings, the allowlist or Knowledge's `ownerSearch.vectors.plugin`, which match exact ids. So `pluginSettings` falls back to the old entry, and `migrationHints` logs a command for each place that still names it.

## Retired

The OpenClaw 2026.8.1 `force: false` memory-search maintenance patch is retired. Do not apply it to newer runtimes, prune embedding caches, or force a reindex just for a plugin upgrade.
