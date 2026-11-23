import { getEmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { createHarrierEmbeddingAdapter, PLUGIN_ID } from "./adapter.js";
import { registerKnowledgeVectors } from "./knowledge-vectors-service.js";

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Knowledge Embeddings (Harrier)",
  description: "Local, instruction-aware Harrier embeddings for memory search and Knowledge, through managed llama.cpp.",
  register(api) {
    const adapter = createHarrierEmbeddingAdapter({ getEmbeddingProvider });
    api.registerEmbeddingProvider(adapter);
    registerKnowledgeVectors(api, adapter);
  },
});
