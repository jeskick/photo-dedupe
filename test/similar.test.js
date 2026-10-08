import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { extensionsFor } from "../src/extensions.js";
import { runScan } from "../src/engine.js";
import { phashFiles, pythonExecutable } from "../src/phash.js";
import { captureBuckets, clusterPhash, hammingHex } from "../src/similar.js";

test("画面指纹按海明距离分组，不会把差异大的照片串进来", () => {
  assert.equal(hammingHex("0000000000000000", "0000000000000001"), 1);
  assert.equal(hammingHex("0000000000000000", "ffffffffffffffff"), 64);
  const closeA = { path: "a", phash: "0000000000000000" };
  const closeB = { path: "b", phash: "0000000000000003" };
  const far = { path: "c", phash: "ffffffffffffffff" };
  const groups = clusterPhash([far, closeA, closeB], 4);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((file) => file.path).sort(), ["a", "b"]);
});

test("拍摄时间窗口从起点计算，不会把整段拍摄连成一组", () => {
  const start = Date.UTC(2024, 0, 2, 3, 4, 0);
  const files = [0, 2, 4, 30].map((second, index) => ({
    path: String(index),
    captureMs: start + second * 1000,
  }));
  const buckets = captureBuckets(files, 2);
  assert.equal(buckets.length, 1);
  assert.equal(buckets[0].length, 2);
});

test("重新压缩后大小不同的照片仍能按画面找到", async () => {
  const python = pythonExecutable();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-similar-"));
  const maker = path.join(dir, "make.py");
  fs.writeFileSync(maker, `
from pathlib import Path
from PIL import Image, ImageDraw
import sys
root = Path(sys.argv[1])

def save(name, paint, quality):
    image = Image.new("RGB", (320, 240), "white")
    draw = ImageDraw.Draw(image)
    paint(draw)
    exif = Image.Exif()
    exif[36867] = "2020:01:02 03:04:05"
    image.save(root / name, quality=quality, exif=exif)

def red(draw):
    draw.rectangle((30, 30, 280, 200), fill=(200, 20, 20))
    draw.ellipse((80, 60, 180, 160), fill=(250, 220, 40))

def blue(draw):
    draw.rectangle((0, 0, 319, 239), fill=(10, 20, 120))
    draw.polygon([(20, 200), (160, 20), (300, 200)], fill=(20, 160, 70))

save("IMG_0001.jpg", red, 95)
save("IMG_0001 (1).jpg", red, 30)
save("IMG_0002.jpg", blue, 95)
`);
  const made = spawnSync(python, [maker, dir], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr || made.stdout);
  fs.unlinkSync(maker);
  const high = path.join(dir, "IMG_0001.jpg");
  const low = path.join(dir, "IMG_0001 (1).jpg");
  const other = path.join(dir, "IMG_0002.jpg");
  assert.notEqual(fs.statSync(high).size, fs.statSync(low).size);
  try {
    const fingerprints = await phashFiles([high, low, other]);
    const same = hammingHex(fingerprints.get(high), fingerprints.get(low));
    const different = hammingHex(fingerprints.get(high), fingerprints.get(other));
    assert.ok(same <= 4, `同一张的差异是 ${same}`);
    assert.ok(different > 4, `不同照片的差异是 ${different}`);
    const result = await runScan({
      roots: [dir],
      extensions: extensionsFor({ dslrRaw: true, dslrJpeg: true, applePhoto: true, video: true }),
      nameMode: "normalized",
      toleranceSec: 0,
      matchWithoutTime: true,
      similar: true,
      similarDistance: 4,
    });
    assert.equal(result.similarError, null);
    assert.equal(result.groups, 1);
    assert.equal(result.found[0].kind, "similar");
    assert.deepEqual(result.found[0].files.map((file) => file.name).sort(), ["IMG_0001 (1).jpg", "IMG_0001.jpg"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
