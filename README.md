# Knowledge Embeddings (Harrier) for OpenClaw

Local embeddings for OpenClaw memory search, using [Harrier OSS v1 0.6B](https://huggingface.co/SuperPauly/harrier-oss-v1-0.6b-gguf) (Q8_0 GGUF, 1,024 dimensions) on OpenClaw's managed llama.cpp server. Text never leaves the Gateway host. Search queries get a retrieval instruction, and documents are embedded unchanged.

It can also keep a vector index of your Knowledge stores for Knowledge's owner search (see [Knowledge vectors](#knowledge-vectors-optional)).

## Requirements

- OpenClaw 2026.9.8 or newer (tested on 2026.11.5).
- OpenClaw's llama.cpp provider (`@openclaw/llama-cpp-provider`) in **managed** mode, where OpenClaw installs and runs `llama-server`. A llama-server you run yourself is not supported. Managed builds exist for macOS 13.3+ (Apple silicon and Intel), Linux x64/arm64 and Windows x64.
- Disk: about 640 MB for the model (639,447,872 bytes, in `~/.openclaw/models/llama.cpp`) plus the llama.cpp runtime (about 40 MB for Linux x64).
- RAM: about 1.1 GB while the model is loaded (measured on Linux x64 CPU, 2,048-token context, one slot).

## Install

```sh
openclaw plugins install @openclaw/llama-cpp-provider     # skip if already installed
openclaw plugins install openclaw-plugin-knowledge-embeddings
```

The plugin id is `knowledge-embeddings`. It provides the embedding provider `harrier-local`, named after the model, which is what memory search selects.

Then set up llama.cpp for embeddings and select Harrier. OpenClaw's embedding-only setup runs only while memory search is set to `local`, so point it at Harrier's model first. It downloads only that model and the verified llama.cpp server, and leaves your chat model alone:

```sh
openclaw config set memory.search.provider local
openclaw config set memory.search.local.modelPath "hf:SuperPauly/harrier-oss-v1-0.6b-gguf/harrier-oss-v1-0.6B-Q8_0.gguf#5283b8a315ebee0cdc65c04fd7646b3fce8e7c80"
openclaw onboard --non-interactive --accept-risk --auth-choice llama-cpp --llama-cpp-embedding-only
openclaw config set memory.search.provider harrier-local
openclaw gateway restart
```

If llama.cpp is already managed by OpenClaw (for example, you run a local chat model), only the `memory.search.provider harrier-local` line and the restart are needed. The model then downloads on the first embedding.

## Configuration

The minimal config is one line, and the setup above writes it:

```json5
{ memory: { search: { provider: "harrier-local" } } }
```

Optional plugin settings, under `plugins.entries.knowledge-embeddings.config`:

| Setting | Default | What it does |
| --- | --- | --- |
| `warmUp` | on while Harrier is in use | Loads the model when the Gateway starts, so the first search isn't slow. |
| `knowledgeVectors.*` | follows Knowledge | See below. |

## Check that it works

```sh
openclaw plugins list                 # knowledge-embeddings is enabled and loaded
openclaw memory status --deep         # embedding provider harrier-local is ready
openclaw memory search "something you wrote down"
```

After a Gateway restart, the Gateway log shows `knowledge-embeddings warm-up: model loaded in … ms`. If llama.cpp isn't set up, the log and `memory status --deep` print the exact commands to run.

The first embedding on a new machine downloads the model from Hugging Face at a pinned commit. OpenClaw's llama.cpp provider checks the download against Hugging Face's published SHA-256 before using it (tested with OpenClaw 2026.11.5 from an empty model cache).

## Knowledge vectors (optional)

If Knowledge holds the memory slot and its owner search supports a vector leg, Harrier can keep a vector index of every Knowledge store and offer candidates to `knowledge_owner_search`. It sends only ids and scores, and Knowledge checks every hit itself. Turn it on in Knowledge's config, the only setting needed:

```json5
{
  plugins: {
    slots: { memory: "knowledge" },
    entries: {
      knowledge: { config: { ownerSearch: { enabled: true, vectors: { plugin: "knowledge-embeddings" } } } },
    },
  },
}
```

The plugin sees this and turns on its index (`knowledgeVectors.enabled`) and its owner-search supplement (`knowledgeVectors.ownerSupplement`). Both stay off while another plugin holds the memory slot. Set either to `false` in this plugin's config to opt out. If Knowledge names `knowledge-embeddings` but owner search is off or Knowledge does not hold the memory slot, the Gateway log says which setting is missing.

The index lives in `<state>/harrier-local/knowledge-vectors.sqlite` (the directory keeps the plugin's old id), is included in OpenClaw backups, and stays current as Knowledge records change. Tuning options (`watch`, `intervalMs`, `watchDebounceMs`, `batchSize`, `vectorFloor`) are described in the plugin's config schema.

The vector leg (`ownerSearch.vectors`) is not in upstream OpenClaw's Knowledge plugin as of 2026.11. On a Knowledge build without it, this section does nothing.

## Upgrading from harrier-local (0.2.x)

Until 0.3.0 the plugin id was `harrier-local`. The embedding provider keeps that id, so `memory.search.provider: "harrier-local"` and the memory index stay as they are. Config that names the old *plugin* id has to move; the Gateway log prints the exact command for each place. See [CHANGELOG.md](CHANGELOG.md#upgrading-from-02x) for the steps.

## Troubleshooting

- **"Harrier runs on OpenClaw's llama.cpp provider, which is not set up"**: run the commands in that message (they match [Install](#install)).
- **"the llama-cpp plugin is not loaded"**: `openclaw plugins install @openclaw/llama-cpp-provider`, or `openclaw plugins enable llama-cpp` if it is installed but disabled.
- **"points at a llama-server you run yourself"**, or embedding-only setup refuses to replace an existing llama.cpp server: `models.providers.llama-cpp` has a `baseUrl` but no managed `localService`. Harrier needs the managed server. Move any chat models that use `llama-cpp` to another provider, run `openclaw config unset models.providers.llama-cpp`, then the setup in [Install](#install).
- **Managed server problems**: `openclaw doctor` and `openclaw memory status --deep`.

## More

- [CHANGELOG.md](CHANGELOG.md): version history.
- [docs/development.md](docs/development.md): tests, host compatibility checks and internals.
- [docs/publishing.md](docs/publishing.md): release and publish steps.

## License

MIT. See [LICENSE](LICENSE).
