import test from "node:test";
import assert from "node:assert/strict";
import { compileNamePatterns } from "../src/patterns.js";

test("文件名条件用星号匹配整个文件名", () => {
  const patterns = compileNamePatterns("*.pdf, *kk*.pdf");
  assert.deepEqual(patterns.list, ["*.pdf", "*kk*.pdf"]);
  assert.equal(patterns.match("报告.PDF"), true);
  assert.equal(patterns.match("a-kk-b.pdf"), true);
  assert.equal(patterns.match("notes.txt"), false);
  assert.equal(patterns.match("file.pdf.bak"), false);
});

test("太宽的文件名条件会被拒绝", () => {
  assert.throws(() => compileNamePatterns("*"), /更具体/);
  assert.throws(() => compileNamePatterns("*.*"), /更具体/);
});
