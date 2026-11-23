import assert from "node:assert/strict";
import test from "node:test";
import { createHarrierEmbeddingAdapter, HARRIER_MODEL } from "../adapter.js";

function createBoundary() {
  const requests = [];
  const vector = Array.from({ length: 1024 }, () => 0.25);
  const adapter = createHarrierEmbeddingAdapter({
    getEmbeddingProvider: () => ({
      create: async () => ({
        provider: {
          embed: async (input, options) => {
            requests.push({ input, options });
            return vector;
          },
          embedBatch: async (inputs, options) => {
            requests.push({ inputs, options });
            return inputs.map(() => vector);
          },
        },
      }),
    }),
  });
  const config = {
    models: {
      providers: {
        "llama-cpp": {
          baseUrl: "http://127.0.0.1:19432/v1",
          localService: { command: "/synthetic/llama-server" },
        },
      },
    },
  };
  return { requests, create: () => adapter.create({ config, model: HARRIER_MODEL }) };
}

test("preserves an explicit host query instruction instead of applying a second template", async () => {
  const boundary = createBoundary();
  const { provider } = await boundary.create();
  const signal = new AbortController().signal;
  await provider.embed("custom query: find this", {
    inputType: "query",
    queryInstructionApplied: true,
    signal,
  });
  assert.deepEqual(boundary.requests, [{
    input: "custom query: find this",
    options: { inputType: "document", queryInstructionApplied: true, signal },
  }]);
});

test("preserves explicit host query formatting for a batch", async () => {
  const boundary = createBoundary();
  const { provider } = await boundary.create();
  await provider.embedBatch(["custom query: first", "custom query: second"], {
    inputType: "query",
    queryInstructionApplied: true,
  });
  assert.deepEqual(boundary.requests, [{
    inputs: ["custom query: first", "custom query: second"],
    options: { inputType: "document", queryInstructionApplied: true },
  }]);
});
