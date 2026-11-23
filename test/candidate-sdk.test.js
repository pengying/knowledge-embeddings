import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { HARRIER_MODEL } from "../adapter.js";

const sourceDir = process.env.OPENCLAW_COMPAT_SOURCE_DIR;
const options = { skip: !sourceDir && "set OPENCLAW_COMPAT_SOURCE_DIR to the selected candidate checkout" };
const sourceModule = (relative) => import(pathToFileURL(path.join(path.resolve(sourceDir), relative)).href);

test("the actual selected host discovery parser admits this package", options, async () => {
  const root = path.resolve(sourceDir);
  const hostPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const pluginPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const { satisfiesPluginApiRange } = await sourceModule("src/plugins/package-compat.ts");
  assert.equal(satisfiesPluginApiRange(hostPackage.version, pluginPackage.openclaw.compat.pluginApi), true);
  assert.equal(satisfiesPluginApiRange("2026.9.7", pluginPackage.openclaw.compat.pluginApi), false);
});

test("Harrier registers and runs through the real candidate API, lookup, and memory query owner", options, async () => {
  const root = path.resolve(sourceDir);
  const [{ createPluginRegistry }, { createPluginRecord }, runtime, embeddingSdk, memory] = await Promise.all([
    sourceModule("src/plugins/registry.ts"),
    sourceModule("src/plugins/status.test-helpers.ts"),
    sourceModule("src/plugins/runtime.ts"),
    sourceModule("src/plugin-sdk/embedding-providers.ts"),
    sourceModule("extensions/memory-core/src/memory/manager-embedding-policy.ts"),
  ]);
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {},
    activateGlobalSideEffects: false,
  });
  const previous = runtime.captureActivePluginRegistrySnapshot();
  runtime.setActivePluginRegistry(builder.registry);
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const config = {
    models: { providers: { "llama-cpp": {
      baseUrl: "http://127.0.0.1:19432/v1",
      localService: { command: "/synthetic/llama-server" },
    } } },
  };
  const requests = [];
  const vector = Array.from({ length: 1024 }, () => 0.25);
  try {
    const localRecord = createPluginRecord({ id: "synthetic-local", contracts: { embeddingProviders: ["local"] } });
    builder.registry.plugins.push(localRecord);
    builder.createApi(localRecord, { config }).registerEmbeddingProvider({
      id: "local",
      create: async (createOptions) => ({
        provider: {
          id: "local",
          model: createOptions.model,
          embed: async (input, callOptions) => {
            requests.push({ input, callOptions });
            return vector;
          },
          embedBatch: async (inputs) => inputs.map(() => vector),
        },
      }),
    });
    const entry = (await readFile(new URL("../index.js", import.meta.url), "utf8"))
      .replaceAll('"openclaw/plugin-sdk/embedding-providers"', JSON.stringify(pathToFileURL(path.join(root, "src/plugin-sdk/embedding-providers.ts")).href))
      .replaceAll('"openclaw/plugin-sdk/plugin-entry"', JSON.stringify(pathToFileURL(path.join(root, "src/plugin-sdk/plugin-entry.ts")).href))
      .replaceAll('"./adapter.js"', JSON.stringify(new URL("../adapter.js", import.meta.url).href))
      .replaceAll('"./knowledge-vectors-service.js"', JSON.stringify(new URL("../knowledge-vectors-service.js", import.meta.url).href));
    const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(entry).toString("base64")}`);
    const record = createPluginRecord({ id: manifest.id, contracts: manifest.contracts });
    builder.registry.plugins.push(record);
    plugin.register(builder.createApi(record, { config }));
    assert.deepEqual(builder.registry.diagnostics.filter(({ level }) => level === "error"), []);
    // The plugin is knowledge-embeddings; its embedding provider keeps the id harrier-local.
    assert.equal(manifest.id, "knowledge-embeddings");
    assert.deepEqual(record.embeddingProviderIds, ["harrier-local"]);
    const registered = embeddingSdk.getEmbeddingProvider("harrier-local", config);
    assert.ok(registered);
    const result = await registered.create({ config, model: HARRIER_MODEL });
    assert.ok(result.provider);
    assert.equal(result.provider.dimensions, 1024);
    assert.equal(result.provider.model, "harrier-oss-v1-0.6b-q8_0");
    await memory.embedMemoryQuery(result.provider, "find this", {}, {});
    await memory.embedMemoryQuery(result.provider, "find this", { queryInstruction: "custom query: " }, {});
    assert.deepEqual(requests.map(({ input }) => input), [
      "Instruct: Given a memory search query, retrieve relevant passages from the user's personal memory that answer the query\nQuery: find this",
      "custom query: find this",
    ]);
    assert.equal(requests[1].callOptions.queryInstructionApplied, true);
  } finally {
    runtime.rollbackStagedPluginRegistry(previous);
  }
});

test("knowledge vectors register with the real host only when flagged, under the knowledge-embeddings id", options, async () => {
  const root = path.resolve(sourceDir);
  const [{ createPluginRegistry }, { createPluginRecord }, runtime] = await Promise.all([
    sourceModule("src/plugins/registry.ts"),
    sourceModule("src/plugins/status.test-helpers.ts"),
    sourceModule("src/plugins/runtime.ts"),
  ]);
  const manifest = JSON.parse(await readFile(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
  const entry = (await readFile(new URL("../index.js", import.meta.url), "utf8"))
    .replaceAll('"openclaw/plugin-sdk/embedding-providers"', JSON.stringify(pathToFileURL(path.join(root, "src/plugin-sdk/embedding-providers.ts")).href))
    .replaceAll('"openclaw/plugin-sdk/plugin-entry"', JSON.stringify(pathToFileURL(path.join(root, "src/plugin-sdk/plugin-entry.ts")).href))
    .replaceAll('"./adapter.js"', JSON.stringify(new URL("../adapter.js", import.meta.url).href))
    .replaceAll('"./knowledge-vectors-service.js"', JSON.stringify(new URL("../knowledge-vectors-service.js", import.meta.url).href));
  const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(entry).toString("base64")}`);
  const registered = (pluginConfig) => {
    const builder = createPluginRegistry({
      logger: { info() {}, warn() {}, error() {}, debug() {} },
      runtime: {},
      activateGlobalSideEffects: false,
    });
    const previous = runtime.captureActivePluginRegistrySnapshot();
    runtime.setActivePluginRegistry(builder.registry);
    try {
      const record = createPluginRecord({ id: manifest.id, contracts: manifest.contracts });
      builder.registry.plugins.push(record);
      plugin.register(builder.createApi(record, { config: {}, ...(pluginConfig ? { pluginConfig } : {}) }));
      assert.deepEqual(builder.registry.diagnostics.filter(({ level }) => level === "error"), []);
      return {
        supplements: builder.registry.memoryCorpusSupplements.map((s) => s.pluginId),
        services: builder.registry.services.filter((s) => s.pluginId === "knowledge-embeddings").map((s) => s.service.id),
      };
    } finally {
      runtime.rollbackStagedPluginRegistry(previous);
    }
  };
  assert.deepEqual(registered(undefined), { supplements: [], services: [] });
  assert.deepEqual(registered({ knowledgeVectors: { enabled: true } }), {
    supplements: [],
    services: ["knowledge-embeddings:knowledge-vectors"],
  });
  assert.deepEqual(registered({ knowledgeVectors: { enabled: true, ownerSupplement: true } }), {
    supplements: ["knowledge-embeddings"],
    services: ["knowledge-embeddings:knowledge-vectors"],
  });
});
