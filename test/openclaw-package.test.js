import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const packageDir = process.env.OPENCLAW_COMPAT_PACKAGE_DIR;
const options = { skip: !packageDir && "set OPENCLAW_COMPAT_PACKAGE_DIR to the built candidate" };

test("the built host SDK and discovery parser accept and register Harrier", options, async () => {
  const root = path.resolve(packageDir);
  const hostPackage = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const pluginPackage = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const compatibilityChunks = (await readdir(path.join(root, "dist")))
    .filter((name) => /^package-compat-.*\.mjs$/u.test(name));
  assert.equal(compatibilityChunks.length, 1, "use the selected build's actual discovery parser");
  const compatibilityModule = await import(pathToFileURL(path.join(root, "dist", compatibilityChunks[0])).href);
  const satisfiesPluginApiRange = Object.values(compatibilityModule)
    .find((value) => typeof value === "function" && value.name === "satisfiesPluginApiRange");
  assert.equal(typeof satisfiesPluginApiRange, "function");
  assert.equal(satisfiesPluginApiRange(hostPackage.version, pluginPackage.openclaw.compat.pluginApi), true);
  const hostRequire = createRequire(path.join(root, "package.json"));
  const entry = (await readFile(new URL("../index.js", import.meta.url), "utf8"))
    .replaceAll('"openclaw/plugin-sdk/embedding-providers"', JSON.stringify(pathToFileURL(hostRequire.resolve("openclaw/plugin-sdk/embedding-providers")).href))
    .replaceAll('"openclaw/plugin-sdk/plugin-entry"', JSON.stringify(pathToFileURL(hostRequire.resolve("openclaw/plugin-sdk/plugin-entry")).href))
    .replaceAll('"./adapter.js"', JSON.stringify(new URL("../adapter.js", import.meta.url).href))
    .replaceAll('"./knowledge-vectors-service.js"', JSON.stringify(new URL("../knowledge-vectors-service.js", import.meta.url).href));
  const { default: plugin } = await import(`data:text/javascript;base64,${Buffer.from(entry).toString("base64")}`);
  const registrations = [];
  plugin.register({ registerEmbeddingProvider: (adapter) => registrations.push(adapter) });
  assert.equal(plugin.id, "knowledge-embeddings");
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, "harrier-local");
  assert.equal(registrations[0].normalizeModel({ model: "harrier-oss-v1-0.6b-q8_0" }), "harrier-oss-v1-0.6b-q8_0");
  assert.equal(typeof registrations[0].create, "function");
});
