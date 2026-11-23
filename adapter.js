/** The plugin id. Until 0.3.0 it was harrier-local (LEGACY_PLUGIN_ID). */
export const PLUGIN_ID = "knowledge-embeddings";
export const LEGACY_PLUGIN_ID = "harrier-local";
/**
 * The embedding provider id, which names the model. It keeps the old plugin id, so
 * memory.search.provider configs and memory index identities carry over unchanged.
 */
export const HARRIER_PROVIDER_ID = "harrier-local";
export const HARRIER_MODEL = "harrier-oss-v1-0.6b-q8_0";
export const HARRIER_GGUF_SOURCE =
  "hf:SuperPauly/harrier-oss-v1-0.6b-gguf/harrier-oss-v1-0.6B-Q8_0.gguf#5283b8a315ebee0cdc65c04fd7646b3fce8e7c80";
export const HARRIER_GGUF_SHA256 =
  "f97092bd73f6814b8b1170ca855071bc468b5fa2cf61a6de7e1d2c4a8a6a50b0";
export const LLAMA_CPP_PROVIDER_ID = "llama-cpp";
export const LOCAL_DELEGATE_ID = "local";
export const HARRIER_DIMENSIONS = 1024;
export const HARRIER_MAX_INPUT_TOKENS = 32768;
export const HARRIER_INSTRUCTION_VERSION = "personal-memory-retrieval-v1";
export const HARRIER_QUERY_INSTRUCTION =
  "Instruct: Given a memory search query, retrieve relevant passages from the user's personal memory that answer the query";
/** OpenClaw's official llama.cpp provider plugin, which installs and runs llama-server. */
export const LLAMA_CPP_PLUGIN_PACKAGE = "@openclaw/llama-cpp-provider";

// OpenClaw's embedding-only llama.cpp setup runs only for `memory.search.provider: "local"`,
// so setup points it at Harrier's GGUF first; it downloads that model, not the default one.
export const LLAMA_CPP_SETUP_COMMANDS = [
  `openclaw plugins install ${LLAMA_CPP_PLUGIN_PACKAGE}`,
  "openclaw config set memory.search.provider local",
  `openclaw config set memory.search.local.modelPath "${HARRIER_GGUF_SOURCE}"`,
  "openclaw onboard --non-interactive --accept-risk --auth-choice llama-cpp --llama-cpp-embedding-only",
  `openclaw config set memory.search.provider ${HARRIER_PROVIDER_ID}`,
];

const SETUP_STEPS =
  LLAMA_CPP_SETUP_COMMANDS.map((command) => `  ${command}`).join("\n") +
  "\nSkip the first command if llama-cpp is already installed. Setup downloads the llama.cpp server " +
  "and the Harrier model (about 640 MB). Then restart the Gateway.";

const LLAMA_CPP_NOT_SET_UP =
  "Harrier runs on OpenClaw's llama.cpp provider, which is not set up on this Gateway yet " +
  "(models.providers.llama-cpp has no managed localService). On the Gateway host, run:\n" +
  SETUP_STEPS;

// OpenClaw's embedding-only setup refuses to replace an existing llama.cpp provider config
// without a managed localService, so the setup commands work only once that config is gone.
const llamaCppConfigInTheWay = (providerConfig) =>
  (providerConfig.baseUrl !== undefined
    ? "models.providers.llama-cpp points at a llama-server you run yourself (a baseUrl with no managed localService). "
    : "models.providers.llama-cpp is configured without a managed localService. ") +
  "Harrier needs OpenClaw's managed llama.cpp server, and OpenClaw's setup will not replace an existing " +
  "llama.cpp config. To switch, move any chat models that use llama-cpp to another provider, remove that " +
  "config, and set up the managed server. On the Gateway host, run:\n" +
  `  openclaw config unset models.providers.${LLAMA_CPP_PROVIDER_ID}\n` +
  SETUP_STEPS;

const LLAMA_CPP_NOT_LOADED =
  "Harrier runs on OpenClaw's llama.cpp provider, but the llama-cpp plugin is not loaded. Run " +
  `\`openclaw plugins install ${LLAMA_CPP_PLUGIN_PACKAGE}\` (or \`openclaw plugins enable llama-cpp\` ` +
  "if it is installed but disabled), then restart the Gateway.";

function managedBaseUrl(config) {
  const providerConfig =
    config?.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  const localService = providerConfig?.localService;
  if (providerConfig && typeof providerConfig === "object" && !localService) {
    throw new Error(llamaCppConfigInTheWay(providerConfig));
  }
  if (
    typeof localService !== "object" ||
    localService === null ||
    Array.isArray(localService)
  ) {
    throw new Error(LLAMA_CPP_NOT_SET_UP);
  }

  const raw = providerConfig.baseUrl;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new Error(
      "models.providers.llama-cpp.baseUrl is required for local Harrier embeddings. " +
        "Rerun the llama.cpp setup on the Gateway host:\n" +
        SETUP_STEPS,
    );
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(
      "The managed llama.cpp endpoint must be an HTTP loopback URL ending in /v1 with no credentials, query, or fragment.",
    );
  }

  const port = Number(url.port);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65_535 ||
    url.pathname !== "/v1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "The managed llama.cpp endpoint must be an HTTP loopback URL ending in /v1 with no credentials, query, or fragment.",
    );
  }

  return url.href;
}

function normalizeModel(model = "") {
  const normalized = model.trim().replace(/^harrier-local\//u, "");
  if (!normalized || normalized === HARRIER_MODEL) {
    return HARRIER_MODEL;
  }
  throw new Error(`Unsupported Harrier embedding model: ${model}`);
}

function transformInput(input, options) {
  if (options?.inputType !== "query" || options.queryInstructionApplied === true) {
    return input;
  }

  const text = typeof input === "string" ? input : input.text;
  const transformed = `${HARRIER_QUERY_INSTRUCTION}\nQuery: ${text}`;
  return transformed;
}

function delegateOptions(options) {
  return options?.inputType === "query"
    ? { ...options, inputType: "document" }
    : options;
}

function identityFor(model, baseUrl) {
  return {
    model,
    cacheKeyData: {
      provider: HARRIER_PROVIDER_ID,
      model,
      quantization: "Q8_0",
      outputDimensionality: HARRIER_DIMENSIONS,
      instructionVersion: HARRIER_INSTRUCTION_VERSION,
      ggufSource: HARRIER_GGUF_SOURCE,
      ggufSha256: HARRIER_GGUF_SHA256,
      baseUrl,
    },
    aliases: [],
  };
}

function validateVectorDimensions(vector) {
  const actualDimensions = vector?.length;
  if (actualDimensions !== HARRIER_DIMENSIONS) {
    throw new Error(
      `Harrier embedding dimension mismatch: expected ${HARRIER_DIMENSIONS}, actual ${String(actualDimensions)}.`,
    );
  }
  const invalidIndex = vector.findIndex((value) => !Number.isFinite(value));
  if (invalidIndex !== -1) {
    throw new Error(
      `Harrier embedding contains a non-finite value at index ${invalidIndex}.`,
    );
  }
  return vector;
}

function validateBatchDimensions(vectors) {
  for (const vector of vectors) {
    validateVectorDimensions(vector);
  }
  return vectors;
}

export function createHarrierEmbeddingAdapter({ getEmbeddingProvider }) {
  return {
    id: HARRIER_PROVIDER_ID,
    defaultModel: HARRIER_MODEL,
    transport: "local",
    normalizeModel: ({ model }) => normalizeModel(model),
    resolveIndexIdentity: ({ config, model }) =>
      identityFor(normalizeModel(model), managedBaseUrl(config)),
    formatSetupError: (error) =>
      `Local Harrier embeddings are unavailable: ${
        error instanceof Error ? error.message : String(error)
      }`,
    create: async (options) => {
      const model = normalizeModel(options.model);
      const baseUrl = managedBaseUrl(options.config);
      const local = getEmbeddingProvider(LOCAL_DELEGATE_ID, options.config);
      if (!local) {
        throw new Error(LLAMA_CPP_NOT_LOADED);
      }

      const { remote: _remote, ...forwardedOptions } = options;
      const result = await local.create({
        ...forwardedOptions,
        provider: LOCAL_DELEGATE_ID,
        model,
        local: { ...options.local, modelPath: HARRIER_GGUF_SOURCE },
        dimensions: HARRIER_DIMENSIONS,
      });
      if (!result.provider) {
        return result;
      }

      const delegate = result.provider;
      return {
        provider: {
          id: HARRIER_PROVIDER_ID,
          model,
          dimensions: HARRIER_DIMENSIONS,
          maxInputTokens: HARRIER_MAX_INPUT_TOKENS,
          embed: async (input, callOptions) =>
            validateVectorDimensions(
              await delegate.embed(
                transformInput(input, callOptions),
                delegateOptions(callOptions),
              ),
            ),
          embedBatch: async (inputs, callOptions) =>
            validateBatchDimensions(
              await delegate.embedBatch(
                inputs.map((input) =>
                  transformInput(input, callOptions),
                ),
                delegateOptions(callOptions),
              ),
            ),
          close: delegate.close,
        },
        runtime: {
          ...result.runtime,
          id: HARRIER_PROVIDER_ID,
          cacheKeyData: identityFor(model, baseUrl).cacheKeyData,
        },
      };
    },
  };
}
