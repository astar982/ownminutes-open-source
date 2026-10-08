#!/usr/bin/env node

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const flat = {
  version: 3,
  sources: ["a.js"],
  sourcesContent: ["a"],
  names: [],
  mappings: "AAAA",
};
const indexed = (line, map = flat) => ({
  version: 3,
  sections: [{ offset: { line, column: 0 }, map }],
});

for (const packageUrl of [new URL("../package.json", import.meta.url), new URL("../apps/mobile/package.json", import.meta.url)]) {
  const require = createRequire(packageUrl);
  const { SourceMapConsumer, SourceNode } = require("source-map-js");
  assert.throws(() => new SourceMapConsumer(indexed(10000001)), /must not exceed/);
  assert.throws(() => new SourceMapConsumer(indexed(0.5)), /non-negative integers/);
  assert.throws(() => new SourceMapConsumer(indexed(6000000, indexed(6000000))), /nested sections/);

  const consumer = new SourceMapConsumer(indexed(1));
  assert.equal(consumer.originalPositionFor({ line: 2, column: 1 }).source, "a.js");
  assert.equal(SourceNode.fromStringWithSourceMap("\na", consumer).toString(), "\na");
  const result = require("postcss")([]).process("a { color: red; }", {
    from: "a.css",
    to: "out.css",
    map: { inline: false, annotation: false },
  });
  assert.equal(result.css, "a { color: red; }");
  assert.ok(result.map);
  console.log(`${packageUrl.pathname}: unsafe source-map offsets rejected; indexed mapping, SourceNode and PostCSS controls passed.`);
}
