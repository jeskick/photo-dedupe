import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extensionsFor } from "../src/extensions.js";
import { runScan } from "../src/engine.js";
import { planDeletions } from "../src/delete.js";
import { buildJpeg, buildMp4 } from "./builders.js";

const allKinds = extensionsFor({ dslrRaw: true, dslrJpeg: true, applePhoto: true, video: true });

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}

test("按大小、拍摄时间和文件名确认重复，内容不同则排除", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-dedupe-scan-"));
  const same = buildJpeg("2020:01:02 03:04:05", "12", "same-payload");
  const other = buildJpeg("2020:01:02 03:04:05", "12", "other-payloa");
  const later = buildJpeg("2020:01:02 03:04:08", "12", "same-payload");
  const video = buildMp4("2021-05-06T07:08:09+08:00").file;
  write(path.join(dir, "a", "IMG_0001.jpg"), same);
  write(path.join(dir, "b", "IMG_0001 (1).jpg"), same);
  write(path.join(dir, "c", "IMG_0001.jpg"), other);
  write(path.join(dir, "d", "IMG_0001.jpg"), later);
  write(path.join(dir, "e", "DSC_9999.jpg"), same);
  write(path.join(dir, "v", "clip.mp4"), video);
  write(path.join(dir, "v2", "clip (1).mp4"), video);
  write(path.join(dir, "b", "IMG_0001 (1).xmp"), Buffer.from("<xmp/>"));
  try {
    const result = await runScan({
      roots: [dir, path.join(dir, "a"), path.join(dir, "missing-dir")],
      extensions: allKinds,
      nameMode: "normalized",
      toleranceSec: 0,
      matchWithoutTime: true,
    });
    assert.equal(result.groups, 2);
    assert.equal(result.nestedRoots.length, 1);
    assert.equal(result.invalidRoots.length, 1);
    const photo = result.found.find((group) => group.files[0].ext === ".jpg");
    const movie = result.found.find((group) => group.files[0].ext === ".mp4");
    assert.equal(photo.files.length, 2);
    assert.equal(photo.files.find((file) => file.role === "keep").name, "IMG_0001.jpg");
    assert.equal(photo.files.find((file) => file.role === "delete").name, "IMG_0001 (1).jpg");
    assert.equal(photo.captureMs, Date.UTC(2020, 0, 2, 3, 4, 5, 120));
    assert.equal(movie.captureMs, Date.UTC(2021, 4, 6, 7, 8, 9));
    assert.ok(result.metaBytes < result.found.reduce((sum, group) => sum + group.size * group.files.length, 0) + 5_000_000);

    const job = { groups: result.found.map((group) => ({ ...group, files: group.files.map((file) => ({ ...file })) })) };
    const planned = await planDeletions(job, { includeSidecars: true });
    assert.equal(planned.deletions.length, 2);
    assert.ok(planned.deletions.some((item) => item.sidecars.length === 1));
    assert.ok(planned.deletions.every((item) => !item.path.endsWith(`${path.sep}IMG_0001.jpg`) || item.path.includes(`${path.sep}b${path.sep}`)));

    const changed = planned.deletions.find((item) => item.path.endsWith(".jpg"));
    const current = fs.readFileSync(changed.path);
    const mutated = Buffer.concat([current.subarray(0, current.length - 1), Buffer.from("Z")]);
    fs.writeFileSync(changed.path, mutated);
    const future = new Date(Date.now() + 10_000);
    fs.utimesSync(changed.path, future, future);
    const again = await planDeletions(job, { includeSidecars: false });
    assert.ok(again.skipped.some((item) => item.path === changed.path));
    assert.equal(again.deletions.some((item) => item.path === changed.path), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("硬链接只保留一份索引", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-dedupe-link-"));
  const bytes = buildJpeg("2020:01:02 03:04:05", "12", "linked-payload");
  const source = path.join(dir, "IMG_0001.jpg");
  const linked = path.join(dir, "copy", "IMG_0001.jpg");
  write(source, bytes);
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  try {
    fs.linkSync(source, linked);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  try {
    const result = await runScan({
      roots: [dir],
      extensions: allKinds,
      nameMode: "normalized",
      toleranceSec: 0,
      matchWithoutTime: true,
    });
    assert.equal(result.filesScanned, 1);
    assert.equal(result.hardlinksSkipped, 1);
    assert.equal(result.groups, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("软件目录里的图标不参与查重，拍摄目录仍保留", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-dedupe-soft-"));
  const photo = buildJpeg("2020:01:02 03:04:05", "12", "camera-photo");
  const icon = buildJpeg("2020:01:02 03:04:05", "12", "app-icon");
  write(path.join(dir, "DCIM", "IMG_1001.jpg"), photo);
  write(path.join(dir, "DCIM", "IMG_1001 (1).jpg"), photo);
  write(path.join(dir, "美图", "app.exe"), Buffer.from("MZ"));
  write(path.join(dir, "美图", "logo.jpg"), icon);
  write(path.join(dir, "美图", "images", "banner.jpg"), icon);
  write(path.join(dir, "相册", "icons", "favicon.jpg"), icon);
  try {
    const result = await runScan({
      roots: [dir],
      extensions: allKinds,
      nameMode: "normalized",
      toleranceSec: 0,
      matchWithoutTime: true,
      similar: false,
    });
    assert.equal(result.filesScanned, 2);
    assert.equal(result.groups, 1);
    assert.ok(result.softwareSkipped >= 2);
    assert.deepEqual(result.found[0].files.map((file) => file.name).sort(), ["IMG_1001 (1).jpg", "IMG_1001.jpg"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
