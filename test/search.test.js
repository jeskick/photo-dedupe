import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { searchFiles } from "../src/search.js";

test("按文件名条件只列出内容相同的重复，名字不同也对得上", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-dedupe-find-"));
  const groups = [];
  try {
    fs.mkdirSync(path.join(dir, "mixed"), { recursive: true });
    fs.mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    const same = Buffer.from("zip-same-bytes");
    fs.writeFileSync(path.join(dir, "mixed", "report-kk.zip"), same);
    fs.writeFileSync(path.join(dir, "mixed", "Archive-KK (1).ZIP"), same);
    fs.writeFileSync(path.join(dir, "mixed", "notes.txt"), Buffer.from("notes"));
    fs.writeFileSync(path.join(dir, "mixed", "other.zip"), same);
    fs.writeFileSync(path.join(dir, "mixed", "alone.zip"), Buffer.from("zip-only-once"));
    fs.writeFileSync(path.join(dir, "node_modules", "pkg", "backup-kk.zip"), same);
    fs.mkdirSync(path.join(dir, "skip"), { recursive: true });
    fs.writeFileSync(path.join(dir, "skip", "backup-kk.zip"), same);
    const result = await searchFiles({
      roots: [dir],
      patterns: "*kk*.zip",
      excludeDirs: [path.join(dir, "skip")],
      onGroup: (group) => groups.push(group),
    });
    assert.equal(result.files, 3);
    assert.equal(result.groups, 1);
    assert.deepEqual(groups[0].files.map((file) => file.name).sort(), ["Archive-KK (1).ZIP", "backup-kk.zip", "report-kk.zip"]);
    assert.equal(groups[0].files.filter((file) => file.role === "keep").length, 1);
    assert.equal(groups[0].files.some((file) => file.path.includes(`${path.sep}node_modules${path.sep}`)), true);
    assert.equal(groups[0].files.some((file) => file.path.includes(`${path.sep}skip${path.sep}`)), false);
    assert.equal(result.excluded > 0, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("*.zip 会对比全部 zip，包括夹着其他文件的目录", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-dedupe-find-all-"));
  try {
    fs.mkdirSync(path.join(dir, "docs"), { recursive: true });
    const same = Buffer.from("all-zips");
    fs.writeFileSync(path.join(dir, "docs", "a.zip"), same);
    fs.writeFileSync(path.join(dir, "docs", "b.zip"), same);
    fs.writeFileSync(path.join(dir, "docs", "readme.txt"), Buffer.from("text"));
    const result = await searchFiles({ roots: [dir], patterns: "*.zip" });
    assert.equal(result.files, 2);
    assert.equal(result.groups, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
