import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { catalogFiles, parseDriveList, utcParts } from "../src/library-scan.js";
import { libraryCount, libraryPhoto, libraryTree, openLibrary, purgeScan, queryPhotos, setRating, upsertPhotos } from "../src/library-db.js";
import { pairedCameraPaths } from "../src/library-scan.js";
import { buildJpeg } from "./builders.js";

test("磁盘列表只保留盘符", () => {
  assert.deepEqual(parseDriveList("C:\r\nD:\r\n\r\nnot-a-drive\r\n"), ["C:\\", "D:\\"]);
});

test("拍摄日期按相机上的年月日分组", () => {
  assert.deepEqual(utcParts(Date.UTC(2020, 0, 2, 3, 4, 5)), { year: 2020, month: 1, day: 2 });
});

test("照片库按时间保存，混有其他文件的目录不进入", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-library-"));
  const dbPath = path.join(dir, "library.sqlite");
  const photo = buildJpeg("2020:01:02 03:04:05", "12", "library-photo");
  fs.mkdirSync(path.join(dir, "相册"));
  fs.writeFileSync(path.join(dir, "相册", "IMG_0001.jpg"), photo);
  fs.writeFileSync(path.join(dir, "相册", "IMG_0001 (1).jpg"), photo);
  fs.mkdirSync(path.join(dir, "文档", "内层"), { recursive: true });
  fs.writeFileSync(path.join(dir, "文档", "notes.txt"), "hello");
  fs.writeFileSync(path.join(dir, "文档", "内层", "skip.jpg"), photo);
  const found = [];
  const result = catalogFiles([dir], { onFile: (file) => found.push(file) });
  assert.equal(result.files, 2);
  assert.equal(found.every((file) => file.year === 2020 && file.month === 1 && file.day === 2), true);
  assert.equal(found.some((file) => file.path.includes("skip.jpg")), false);

  const db = openLibrary(dbPath);
  upsertPhotos(db, found, 1);
  upsertPhotos(db, found.map((file) => ({ ...file, name: "kept.jpg" })), 2);
  assert.equal(libraryCount(db), 2);
  purgeScan(db, 2);
  assert.equal(libraryCount(db), 2);
  const tree = libraryTree(db);
  assert.equal(tree[0].count, 2);
  const listed = queryPhotos(db, { year: 2020, month: 1, q: "kept" });
  assert.equal(listed.length, 2);
  const kept = listed[0];
  setRating(db, kept.path, 4);
  upsertPhotos(db, found.map((file) => ({ ...file, name: "kept.jpg" })), 3);
  assert.equal(libraryPhoto(db, kept.path).rating, 4);
  db.close();
});

test("同目录同名的 CR2 和 JPG 会一起列出", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-pair-"));
  const jpg = path.join(dir, "IMG_0001.JPG");
  const cr2 = path.join(dir, "IMG_0001.CR2");
  fs.writeFileSync(jpg, "a");
  fs.writeFileSync(cr2, "b");
  fs.writeFileSync(path.join(dir, "IMG_0001.xmp"), "c");
  fs.writeFileSync(path.join(dir, "other.jpg"), "d");
  const paired = pairedCameraPaths(jpg).map((item) => path.basename(item).toLowerCase()).sort();
  assert.deepEqual(paired, ["img_0001.cr2", "img_0001.jpg"]);
  assert.deepEqual(pairedCameraPaths(path.join(dir, "other.jpg")).map((item) => path.basename(item)), ["other.jpg"]);
});
