import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createHarrierEmbeddingAdapter,
  HARRIER_DIMENSIONS,
  HARRIER_GGUF_SHA256,
  HARRIER_GGUF_SOURCE,
  HARRIER_INSTRUCTION_VERSION,
  HARRIER_MAX_INPUT_TOKENS,
  HARRIER_MODEL,
  HARRIER_PROVIDER_ID,
  HARRIER_QUERY_INSTRUCTION,
  LEGACY_PLUGIN_ID,
  PLUGIN_ID,
  LLAMA_CPP_PLUGIN_PACKAGE,
  LLAMA_CPP_PROVIDER_ID,
  LLAMA_CPP_SETUP_COMMANDS,
  LOCAL_DELEGATE_ID,
} from "../adapter.js";

const expectedInstruction =
  "Instruct: Given a memory search query, retrieve relevant passages from the user's personal memory that answer the query";
const managedBaseUrl = "http://127.0.0.1:19432/v1";
const expectedGgufSource =
  "hf:SuperPauly/harrier-oss-v1-0.6b-gguf/harrier-oss-v1-0.6B-Q8_0.gguf#5283b8a315ebee0cdc65c04fd7646b3fce8e7c80";
const expectedGgufSha256 =
  "f97092bd73f6814b8b1170ca855071bc468b5fa2cf61a6de7e1d2c4a8a6a50b0";

function realisticLocalService() {
  return {
    command: "/home/example/.openclaw/providers/llama-cpp/bin/llama-server",
    args: ["--host", "127.0.0.1", "--port", "19432", "--embedding"],
    healthUrl: "http://127.0.0.1:19432/health",
  };
}

function managedConfig(baseUrl = managedBaseUrl, localService = realisticLocalService()) {
  return {
    models: {
      providers: {
        [LLAMA_CPP_PROVIDER_ID]: { baseUrl, localService },
      },
    },
  };
}

function makeVector(dimensions = HARRIER_DIMENSIONS) {
  return Array.from({ length: dimensions }, () => 0);
}

function serializeLikeOpenAiCompatible(input) {
  if (typeof input === "string") {
    return input;
  }
  if (Array.isArray(input.parts) && input.parts.length > 0) {
    return input.parts.map((part) => part.text).join("\n");
  }
  return input.text;
}

function makeSubject(overrides = {}) {
  const calls = [];
  const batchCalls = [];
  const close = async () => "closed";
  const delegateProvider = {
    id: LOCAL_DELEGATE_ID,
    model: "delegate-model",
    dimensions: 42,
    maxInputTokens: 99,
    async embed(input, options) {
      calls.push({ input, options });
      return makeVector();
    },
    async embedBatch(inputs, options) {
      batchCalls.push({ inputs, options });
      return inputs.map(() => makeVector());
    },
    close,
    ...overrides.delegateProvider,
  };
  const delegateResult =
    overrides.delegateResult === undefined
      ? {
          provider: delegateProvider,
          runtime: {
            id: LOCAL_DELEGATE_ID,
            baseUrl: managedBaseUrl,
            cacheKeyData: { provider: LOCAL_DELEGATE_ID, stale: true },
          },
        }
      : overrides.delegateResult;
  const createCalls = [];
  const localAdapter =
    overrides.localAdapter === undefined
      ? {
          async create(options) {
            createCalls.push(options);
            return delegateResult;
          },
        }
      : overrides.localAdapter;
  const getCalls = [];
  const getEmbeddingProvider =
    overrides.getEmbeddingProvider ??
    ((id, config) => {
      getCalls.push({ id, config });
      return localAdapter;
    });

  return {
    adapter: createHarrierEmbeddingAdapter({ getEmbeddingProvider }),
    batchCalls,
    calls,
    close,
    createCalls,
    delegateProvider,
    delegateResult,
    getCalls,
  };
}

test("exports the exact Harrier contract constants", () => {
  // The plugin is knowledge-embeddings; the provider id names the model and keeps the old
  // plugin id, so memory.search.provider configs and memory index identities carry over.
  assert.equal(PLUGIN_ID, "knowledge-embeddings");
  assert.equal(LEGACY_PLUGIN_ID, "harrier-local");
  assert.equal(HARRIER_PROVIDER_ID, "harrier-local");
  assert.equal(HARRIER_MODEL, "harrier-oss-v1-0.6b-q8_0");
  assert.equal(
    HARRIER_GGUF_SOURCE,
    expectedGgufSource,
  );
  assert.equal(HARRIER_GGUF_SHA256, expectedGgufSha256);
  assert.equal(LLAMA_CPP_PROVIDER_ID, "llama-cpp");
  assert.equal(LOCAL_DELEGATE_ID, "local");
  assert.equal(HARRIER_DIMENSIONS, 1024);
  assert.equal(HARRIER_MAX_INPUT_TOKENS, 32768);
  assert.equal(HARRIER_INSTRUCTION_VERSION, "personal-memory-retrieval-v1");
  assert.equal(HARRIER_QUERY_INSTRUCTION, expectedInstruction);
});

test("exposes the Harrier adapter metadata", () => {
  const { adapter } = makeSubject();

  assert.equal(adapter.id, HARRIER_PROVIDER_ID);
  assert.equal(adapter.defaultModel, HARRIER_MODEL);
  assert.equal(adapter.transport, "local");
});

test("prefixes a query exactly once and delegates it as a document", async () => {
  const { adapter, calls } = makeSubject();
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });
  const signal = AbortSignal.timeout(1_000);
  const callOptions = { inputType: "query", signal, traceId: "trace-1" };

  await provider.embed("where is dinner?", callOptions);

  const expected = `${HARRIER_QUERY_INSTRUCTION}\nQuery: where is dinner?`;
  assert.equal(calls[0].input, expected);
  assert.equal(calls[0].input.split(HARRIER_QUERY_INSTRUCTION).length - 1, 1);
  assert.deepEqual(calls[0].options, {
    inputType: "document",
    signal,
    traceId: "trace-1",
  });
  assert.deepEqual(callOptions, { inputType: "query", signal, traceId: "trace-1" });
});

test("leaves document text and call options unchanged", async () => {
  const { adapter, calls } = makeSubject();
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });
  const options = { inputType: "document", traceId: "trace-2" };

  await provider.embed("R&G Lounge is Thursday dinner", options);

  assert.equal(calls[0].input, "R&G Lounge is Thursday dinner");
  assert.equal(calls[0].options, options);
});

test("leaves non-query inputs and call options unchanged", async () => {
  const { adapter, calls } = makeSubject();
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });
  const input = { text: "raw text", parts: [{ type: "text", text: "raw text" }] };
  const options = { signal: AbortSignal.timeout(1_000), traceId: "trace-3" };

  await provider.embed(input, options);

  assert.equal(calls[0].input, input);
  assert.equal(calls[0].options, options);
});

test("serializes a structured query on-wire as exactly the instructed text", async () => {
  let onWire;
  let forwardedOptions;
  const { adapter } = makeSubject({
    delegateProvider: {
      async embed(input, options) {
        onWire = serializeLikeOpenAiCompatible(input);
        forwardedOptions = options;
        return makeVector();
      },
    },
  });
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });
  const parts = [{ type: "text", text: "Dianping profile" }];
  const input = { text: "Dianping profile", parts, metadata: { source: "memory" } };
  const original = structuredClone(input);

  await provider.embed(input, { inputType: "query" });

  const expected = `${HARRIER_QUERY_INSTRUCTION}\nQuery: Dianping profile`;
  assert.equal(onWire, expected);
  assert.deepEqual(input, original);
  assert.equal(forwardedOptions.inputType, "document");
});

test("applies the query instruction to every query in a batch", async () => {
  const { adapter, batchCalls } = makeSubject();
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });
  const inputs = ["one", "two"];
  const original = [...inputs];

  await provider.embedBatch(inputs, { inputType: "query", traceId: "batch-1" });

  assert.deepEqual(batchCalls[0].inputs, [
    `${HARRIER_QUERY_INSTRUCTION}\nQuery: one`,
    `${HARRIER_QUERY_INSTRUCTION}\nQuery: two`,
  ]);
  assert.deepEqual(batchCalls[0].options, {
    inputType: "document",
    traceId: "batch-1",
  });
  assert.deepEqual(inputs, original);
});

test("converts structured batch queries to instructed strings without mutation", async () => {
  const { adapter, batchCalls } = makeSubject();
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });
  const inputs = [
    { text: "one", parts: [{ type: "text", text: "one" }] },
    { text: "two", metadata: { order: 2 } },
  ];
  const original = structuredClone(inputs);

  await provider.embedBatch(inputs, { inputType: "query" });

  assert.equal(
    batchCalls[0].inputs[0],
    `${HARRIER_QUERY_INSTRUCTION}\nQuery: one`,
  );
  assert.equal(
    batchCalls[0].inputs[1],
    `${HARRIER_QUERY_INSTRUCTION}\nQuery: two`,
  );
  assert.deepEqual(inputs, original);
});

test("includes the source, endpoint, quantization, dimensions, and instruction in identity", () => {
  const { adapter } = makeSubject();

  assert.deepEqual(adapter.resolveIndexIdentity({ config: managedConfig(), model: HARRIER_MODEL }), {
    model: HARRIER_MODEL,
    cacheKeyData: {
      provider: HARRIER_PROVIDER_ID,
      model: HARRIER_MODEL,
      quantization: "Q8_0",
      outputDimensionality: HARRIER_DIMENSIONS,
      instructionVersion: HARRIER_INSTRUCTION_VERSION,
      ggufSource: HARRIER_GGUF_SOURCE,
      ggufSha256: expectedGgufSha256,
      baseUrl: managedBaseUrl,
    },
    aliases: [],
  });
});

test("defaults an empty model and removes the optional provider prefix", () => {
  const { adapter } = makeSubject();

  assert.equal(adapter.normalizeModel({}), HARRIER_MODEL);
  assert.equal(adapter.normalizeModel({ model: "" }), HARRIER_MODEL);
  assert.equal(adapter.normalizeModel({ model: `  ${HARRIER_PROVIDER_ID}/${HARRIER_MODEL}  ` }), HARRIER_MODEL);
});

test("rejects unsupported model names", () => {
  const { adapter } = makeSubject();

  assert.throws(
    () => adapter.normalizeModel({ model: "harrier-oss-v1-0.6b:q4_k_m" }),
    /Unsupported Harrier embedding model: harrier-oss-v1-0\.6b:q4_k_m/u,
  );
});

test("delegates to local with the Harrier source and no remote configuration", async () => {
  const config = managedConfig();
  const { adapter, createCalls, getCalls } = makeSubject();

  await adapter.create({
    config,
    model: `${HARRIER_PROVIDER_ID}/${HARRIER_MODEL}`,
    provider: HARRIER_PROVIDER_ID,
    remote: { baseUrl: "https://invalid.example" },
    local: { modelPath: "hf:invalid/model.gguf", cacheDir: "/models" },
    custom: true,
  });

  assert.deepEqual(getCalls, [{ id: LOCAL_DELEGATE_ID, config }]);
  assert.deepEqual(createCalls, [
    {
      config,
      model: HARRIER_MODEL,
      provider: LOCAL_DELEGATE_ID,
      local: { modelPath: HARRIER_GGUF_SOURCE, cacheDir: "/models" },
      custom: true,
      dimensions: HARRIER_DIMENSIONS,
    },
  ]);
  assert.equal(Object.hasOwn(createCalls[0], "remote"), false);
});

test("says how to install or enable llama-cpp when its local adapter is missing", async () => {
  const { adapter } = makeSubject({ getEmbeddingProvider: () => undefined });

  await assert.rejects(adapter.create({ config: managedConfig(), model: HARRIER_MODEL }), (error) => {
    assert.match(error.message, /llama-cpp plugin is not loaded/u);
    assert.ok(error.message.includes("openclaw plugins install @openclaw/llama-cpp-provider"));
    assert.ok(error.message.includes("openclaw plugins enable llama-cpp"));
    return true;
  });
});

test("rejects a missing managed llama.cpp endpoint before requesting a delegate", async () => {
  const config = managedConfig();
  delete config.models.providers[LLAMA_CPP_PROVIDER_ID].baseUrl;
  const { adapter, getCalls } = makeSubject();

  await assert.rejects(adapter.create({ config, model: HARRIER_MODEL }), (error) => {
    assert.match(error.message, /models\.providers\.llama-cpp\.baseUrl.*required/iu);
    // The onboard step alone refuses unless memory search is set to local first.
    for (const command of LLAMA_CPP_SETUP_COMMANDS) assert.ok(error.message.includes(command), command);
    return true;
  });
  assert.deepEqual(getCalls, []);
});

for (const [label, localService] of [
  ["non-object", "managed"],
  ["array", []],
]) {
  test(`rejects ${label} managed llama.cpp localService ownership with the setup commands`, async () => {
    const config = managedConfig();
    config.models.providers[LLAMA_CPP_PROVIDER_ID].localService = localService;
    const { adapter, getCalls } = makeSubject();

    await assert.rejects(adapter.create({ config, model: HARRIER_MODEL }), (error) => {
      assert.match(error.message, /llama\.cpp provider, which is not set up/u);
      assert.match(error.message, /models\.providers\.llama-cpp has no managed localService/u);
      for (const command of LLAMA_CPP_SETUP_COMMANDS) assert.ok(error.message.includes(command), command);
      return true;
    });
    assert.deepEqual(getCalls, []);
  });
}

for (const [label, config] of [
  ["no models section", {}],
  ["no llama-cpp provider", { models: { providers: {} } }],
]) {
  test(`tells a machine with ${label} what to run`, () => {
    const { adapter } = makeSubject();
    assert.throws(
      () => adapter.resolveIndexIdentity({ config, model: HARRIER_MODEL }),
      /not set up on this Gateway yet[\s\S]*openclaw onboard --non-interactive --accept-risk --auth-choice llama-cpp --llama-cpp-embedding-only/u,
    );
  });
}

test("an external llama-server is told to remove its config first, not that llama.cpp is not set up", async () => {
  const config = { models: { providers: { [LLAMA_CPP_PROVIDER_ID]: { baseUrl: "http://127.0.0.1:8080/v1" } } } };
  const { adapter, getCalls } = makeSubject();
  const check = (error) => {
    assert.match(error.message, /llama-server you run yourself/u);
    assert.doesNotMatch(error.message, /not set up/u);
    // OpenClaw's setup refuses while the external config is there, so removing it comes first.
    const unset = error.message.indexOf("openclaw config unset models.providers.llama-cpp");
    assert.ok(unset !== -1);
    for (const command of LLAMA_CPP_SETUP_COMMANDS) assert.ok(error.message.indexOf(command) > unset, command);
    return true;
  };
  await assert.rejects(adapter.create({ config, model: HARRIER_MODEL }), check);
  assert.throws(() => adapter.resolveIndexIdentity({ config, model: HARRIER_MODEL }), check);
  // A provider config with no localService at all, or a null one, is refused by setup the same way.
  for (const providerConfig of [{}, { baseUrl: managedBaseUrl, localService: null }]) {
    const other = { models: { providers: { [LLAMA_CPP_PROVIDER_ID]: providerConfig } } };
    assert.throws(() => adapter.resolveIndexIdentity({ config: other, model: HARRIER_MODEL }), (error) => {
      assert.doesNotMatch(error.message, /not set up/u);
      assert.match(error.message, /openclaw config unset models\.providers\.llama-cpp\n/u);
      return true;
    });
  }
  assert.deepEqual(getCalls, []);
});

test("the setup commands install llama-cpp, fetch Harrier's own GGUF, then select Harrier", () => {
  assert.equal(LLAMA_CPP_PLUGIN_PACKAGE, "@openclaw/llama-cpp-provider");
  assert.deepEqual(LLAMA_CPP_SETUP_COMMANDS, [
    "openclaw plugins install @openclaw/llama-cpp-provider",
    "openclaw config set memory.search.provider local",
    `openclaw config set memory.search.local.modelPath "${expectedGgufSource}"`,
    "openclaw onboard --non-interactive --accept-risk --auth-choice llama-cpp --llama-cpp-embedding-only",
    "openclaw config set memory.search.provider harrier-local",
  ]);
});

for (const [label, baseUrl] of [
  ["HTTPS", "https://127.0.0.1:19432/v1"],
  ["no explicit port", "http://127.0.0.1/v1"],
  ["IPv4 explicit default port", "http://127.0.0.1:80/v1"],
  ["IPv6 explicit default port", "http://[::1]:80/v1"],
  ["non-loopback host", "http://203.0.113.10:19432/v1"],
  ["credentials", "http://user:pass@127.0.0.1:19432/v1"],
  ["wrong path", "http://127.0.0.1:19432/embeddings"],
  ["query", "http://127.0.0.1:19432/v1?token=secret"],
  ["fragment", "http://127.0.0.1:19432/v1#fragment"],
]) {
  test(`rejects managed llama.cpp endpoint with ${label}`, async () => {
    const { adapter, getCalls } = makeSubject();

    await assert.rejects(
      adapter.create({ config: managedConfig(baseUrl), model: HARRIER_MODEL }),
      /managed llama\.cpp endpoint.*HTTP loopback.*\/v1/iu,
    );
    assert.deepEqual(getCalls, []);
  });
}

test("accepts the IPv6 loopback managed endpoint", async () => {
  const config = managedConfig("http://[::1]:19432/v1");
  const { adapter, getCalls } = makeSubject();

  await adapter.create({ config, model: HARRIER_MODEL });

  assert.deepEqual(getCalls, [{ id: LOCAL_DELEGATE_ID, config }]);
});

test("preserves a null delegate provider result", async () => {
  const delegateResult = {
    provider: null,
    runtime: { id: LOCAL_DELEGATE_ID, unavailableReason: "offline" },
  };
  const { adapter } = makeSubject({ delegateResult });

  const result = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  assert.equal(result, delegateResult);
});

test("propagates delegate embedding errors", async () => {
  const expected = new Error("delegate exploded");
  const { adapter } = makeSubject({
    delegateProvider: {
      async embed() {
        throw expected;
      },
    },
  });
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  await assert.rejects(provider.embed("query", { inputType: "query" }), (error) => error === expected);
});

test("rejects an embedding with the wrong vector dimensions", async () => {
  const { adapter } = makeSubject({
    delegateProvider: {
      async embed() {
        return makeVector(1023);
      },
    },
  });
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  await assert.rejects(
    provider.embed("query", { inputType: "query" }),
    /expected 1024.*actual 1023/iu,
  );
});

test("rejects a wrong-sized vector within an embedding batch", async () => {
  const { adapter } = makeSubject({
    delegateProvider: {
      async embedBatch() {
        return [makeVector(), makeVector(1025)];
      },
    },
  });
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  await assert.rejects(
    provider.embedBatch(["one", "two"], { inputType: "query" }),
    /expected 1024.*actual 1025/iu,
  );
});

test("rejects non-finite values in a single embedding", async () => {
  const vector = makeVector();
  vector[17] = Number.NaN;
  const { adapter } = makeSubject({
    delegateProvider: {
      async embed() {
        return vector;
      },
    },
  });
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  await assert.rejects(
    provider.embed("query", { inputType: "query" }),
    /non-finite.*index 17/iu,
  );
});

test("rejects non-finite values within an embedding batch", async () => {
  const invalid = makeVector();
  invalid[23] = Number.POSITIVE_INFINITY;
  const { adapter } = makeSubject({
    delegateProvider: {
      async embedBatch() {
        return [makeVector(), invalid];
      },
    },
  });
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  await assert.rejects(
    provider.embedBatch(["one", "two"], { inputType: "document" }),
    /non-finite.*index 23/iu,
  );
});

test("returns valid vectors without copying or mutating them", async () => {
  const vector = makeVector();
  vector[0] = 0.5;
  const batch = [makeVector(), makeVector()];
  const originalVector = [...vector];
  const originalBatch = structuredClone(batch);
  const { adapter } = makeSubject({
    delegateProvider: {
      async embed() {
        return vector;
      },
      async embedBatch() {
        return batch;
      },
    },
  });
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  const embedResult = await provider.embed("one", { inputType: "document" });
  const batchResult = await provider.embedBatch(["one", "two"], {
    inputType: "document",
  });

  assert.equal(embedResult, vector);
  assert.equal(batchResult, batch);
  assert.deepEqual(vector, originalVector);
  assert.deepEqual(batch, originalBatch);
});

test("preserves the delegate close function", async () => {
  const { adapter, close } = makeSubject();
  const { provider } = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  assert.equal(provider.close, close);
  assert.equal(await provider.close(), "closed");
});

test("overrides provider metadata and merges delegate runtime fields", async () => {
  const { adapter } = makeSubject();
  const result = await adapter.create({ config: managedConfig(), model: HARRIER_MODEL });

  assert.equal(result.provider.id, HARRIER_PROVIDER_ID);
  assert.equal(result.provider.model, HARRIER_MODEL);
  assert.equal(result.provider.dimensions, HARRIER_DIMENSIONS);
  assert.equal(result.provider.maxInputTokens, HARRIER_MAX_INPUT_TOKENS);
  assert.deepEqual(result.runtime, {
    id: HARRIER_PROVIDER_ID,
    baseUrl: managedBaseUrl,
    cacheKeyData: {
      provider: HARRIER_PROVIDER_ID,
      model: HARRIER_MODEL,
      quantization: "Q8_0",
      outputDimensionality: HARRIER_DIMENSIONS,
      instructionVersion: HARRIER_INSTRUCTION_VERSION,
      ggufSource: HARRIER_GGUF_SOURCE,
      ggufSha256: expectedGgufSha256,
      baseUrl: managedBaseUrl,
    },
  });
});

test("formats setup errors with a stable Harrier prefix", () => {
  const { adapter } = makeSubject();

  assert.equal(
    adapter.formatSetupError(new Error("connection refused")),
    "Local Harrier embeddings are unavailable: connection refused",
  );
  assert.equal(
    adapter.formatSetupError("not installed"),
    "Local Harrier embeddings are unavailable: not installed",
  );
});

test("declares exact package and manifest metadata", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const manifest = JSON.parse(
    await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  );

  // OpenClaw's scaffold convention for a third-party package: openclaw-plugin-<id>.
  assert.equal(packageJson.name, `openclaw-plugin-${PLUGIN_ID}`);
  assert.equal(packageJson.version, "0.3.0");
  assert.equal(manifest.version, packageJson.version);
  assert.equal(
    packageJson.description,
    "Local, instruction-aware Harrier embeddings for OpenClaw memory search and Knowledge, through OpenClaw's managed llama.cpp provider.",
  );
  assert.equal(packageJson.private, undefined);
  assert.equal(packageJson.type, "module");
  assert.equal(packageJson.scripts.test, "node --test test/*.test.js");
  assert.deepEqual(packageJson.engines, { node: ">=24.16.0 <25 || >=26.1.0" });
  // npm resolves the README's relative links (CHANGELOG.md, docs/, LICENSE) against repository.
  assert.deepEqual(packageJson.repository, { type: "git", url: "git+https://github.com/pengying/knowledge-embeddings.git" });
  assert.equal(packageJson.homepage, "https://github.com/pengying/knowledge-embeddings#readme");
  assert.deepEqual(packageJson.bugs, { url: "https://github.com/pengying/knowledge-embeddings/issues" });
  assert.deepEqual(packageJson.openclaw, {
    extensions: ["./index.js"],
    compat: { pluginApi: ">=2026.9.8", minGatewayVersion: "2026.9.8" },
    build: { openclawVersion: "2026.11.5", pluginSdkVersion: "2026.11.5" },
    install: {
      clawhubSpec: "clawhub:openclaw-plugin-knowledge-embeddings",
      npmSpec: "openclaw-plugin-knowledge-embeddings",
      defaultChoice: "clawhub",
      minHostVersion: ">=2026.9.8",
    },
    release: { publishToClawHub: true, publishToNpm: true },
  });
  // The host plugin loader supplies openclaw/plugin-sdk; a peer dependency would make the
  // installer symlink one host release into the plugin, which breaks on upgrades.
  assert.equal(packageJson.peerDependencies, undefined);
  assert.equal(packageJson.peerDependenciesMeta, undefined);
  assert.equal(packageJson.dependencies, undefined);
  assert.equal(manifest.id, PLUGIN_ID);
  assert.equal(manifest.name, "Knowledge Embeddings (Harrier)");
  // OpenClaw maps the old id to this plugin where it resolves plugin ids (startup planning,
  // npm install id checks); settings under the old entry are read by the plugin itself.
  assert.deepEqual(manifest.legacyPluginIds, [LEGACY_PLUGIN_ID]);
  assert.deepEqual(manifest.requiresPlugins, [LLAMA_CPP_PROVIDER_ID]);
  assert.deepEqual(manifest.contracts.embeddingProviders, [HARRIER_PROVIDER_ID]);
  assert.deepEqual(manifest.activation, { onStartup: true });
  assert.equal(manifest.configSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(manifest.configSchema.properties).toSorted(), [
    "knowledgeVectors",
    "warmUp",
  ]);
  // No schema defaults on the switches whose default follows other config: the host fills
  // schema defaults into pluginConfig, which would hide "unset" from the plugin.
  const vectors = manifest.configSchema.properties.knowledgeVectors;
  assert.equal(vectors.additionalProperties, false);
  for (const schema of [
    manifest.configSchema.properties.warmUp,
    vectors.properties.enabled,
    vectors.properties.ownerSupplement,
  ]) {
    assert.equal(schema.type, "boolean");
    assert.equal(Object.hasOwn(schema, "default"), false);
  }
  // The vectors store is in the backup inventory with its state directory.
  assert.deepEqual(manifest.backupResources, [
    // The store keeps the directory it had under the old id.
    { disposition: "include", scope: "state", relativePath: LEGACY_PLUGIN_ID },
  ]);
});

test("the published files hold every module the entry loads, and no tests", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const files = new Set(packageJson.files);
  const pending = packageJson.openclaw.extensions.map((entry) => entry.replace(/^\.\//u, ""));
  const seen = new Set();
  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(files.has(file), `${file} is loaded at runtime but not in package.json files`);
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    for (const [, specifier] of source.matchAll(/from\s+"(\.\/[^"]+)"/gu)) {
      pending.push(specifier.replace(/^\.\//u, ""));
    }
  }
  // README links into docs/, so it ships too.
  for (const file of ["openclaw.plugin.json", "README.md", "CHANGELOG.md", "docs"]) {
    assert.ok(files.has(file), file);
  }
  assert.equal([...files].some((file) => file.startsWith("test")), false);
});
