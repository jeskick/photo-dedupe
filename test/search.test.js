import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchFiles } from "../src/search.js";

test("搜索文件列出所有对上的名字，夹着其他文件的目录也进入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-dedupe-find-"));
  const found = [];
  try {
    fs.mkdirSync(path.join(dir, "mixed"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(dir, "mixed", "report-kk.zip"), Buffer.from("zip-a"));
    fs.writeFileSync(path.join(dir, "mixed", "notes.txt"), Buffer.from("notes"));
    fs.writeFileSync(path.join(dir, "mixed", "other.zip"), Buffer.from("zip-b"));
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "hidden.zip"), Buffer.from("zip-c"));
    const result = searchFiles({
      roots: [dir],
      patterns: "*kk*.zip *.zip",
      onFile: (file) => found.push(file.name),
    });
    assert.deepEqual(found.sort(), ["other.zip", "report-kk.zip"]);
    assert.equal(result.files, 2);
    assert.equal(result.softwareSkipped > 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
