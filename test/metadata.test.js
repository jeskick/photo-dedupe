import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseMoovBuffer, readCapture } from "../src/metadata.js";
import { buildCr3, buildHeic, buildJpeg, buildMp4 } from "./builders.js";

const shot = Date.UTC(2020, 0, 2, 3, 4, 5, 120);

async function withFile(name, bytes, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-dedupe-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, bytes);
  try {
    await fn(file, bytes.length);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("读取 JPEG EXIF 拍摄时间", async () => {
  const jpeg = buildJpeg("2020:01:02 03:04:05", "12", "payload-a");
  await withFile("IMG_0001.jpg", jpeg, async (file, size) => {
    const result = readCapture(file, ".jpg", size);
    assert.equal(result.capture.captureMs, shot);
    assert.equal(result.capture.subsecKnown, true);
    assert.equal(result.capture.source, "exif");
    assert.ok(result.bytesRead < size + 64 * 1024);
  });
});

test("视频优先使用苹果拍摄时间，并且不读完整文件", async () => {
  const built = buildMp4("2021-05-06T07:08:09+08:00");
  assert.equal(parseMoovBuffer(built.moovBody).captureMs, Date.UTC(2021, 4, 6, 7, 8, 9));
  assert.equal(parseMoovBuffer(built.moovBody).source, "quicktime");
  await withFile("clip.mp4", built.file, async (file, size) => {
    const result = readCapture(file, ".mp4", size);
    assert.equal(result.capture.captureMs, Date.UTC(2021, 4, 6, 7, 8, 9));
    assert.ok(result.bytesRead < size);
  });
});

test("读取 HEIC 和 CR3 里的拍摄时间", async () => {
  await withFile("IMG.HEIC", buildHeic("2020:01:02 03:04:05", "12"), async (file, size) => {
    const result = readCapture(file, ".heic", size);
    assert.equal(result.capture?.captureMs, shot);
    assert.equal(result.capture?.source, "exif");
  });
  await withFile("IMG.CR3", buildCr3("2020:01:02 03:04:05", "12"), async (file, size) => {
    const result = readCapture(file, ".cr3", size);
    assert.equal(result.capture?.captureMs, shot);
  });
});
