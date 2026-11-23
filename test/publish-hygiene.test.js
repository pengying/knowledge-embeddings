// The repository is public: no file may carry a personal home path, a private host or a
// personal address. Placeholders use /home/example/. No OpenClaw imports.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const files = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git" || e.name === "node_modules") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : [p];
  });
// Built from parts, so this file does not match itself.
const PRIVATE_HOST = new RegExp(["duck", "dns", "|", "git", "ea\\."].join(""), "iu");
const PATTERNS = [
  ["a home path", /(?:\/home\/(?!example\/)[A-Za-z0-9._-]+|\/Users\/[A-Za-z0-9._-]+|[A-Z]:\\Users\\)/u],
  ["a private host", PRIVATE_HOST],
  ["an email address", /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}/u],
];

test("no file carries a personal home path, a private host or an email address", () => {
  const found = [];
  for (const file of files(root)) {
    const text = fs.readFileSync(file, "utf8");
    for (const [what, re] of PATTERNS) {
      text.split("\n").forEach((line, i) => {
        if (re.test(line)) found.push(`${path.relative(root, file)}:${i + 1}: ${what}`);
      });
    }
  }
  assert.deepEqual(found, []);
});
