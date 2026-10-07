import test from "node:test";
import assert from "node:assert/strict";
import { clusterByCapture, markOrigins, orderForKeep, sameCapture } from "../src/match.js";

function file(partial) {
  return {
    path: partial.path,
    name: partial.name,
    captureMs: partial.captureMs ?? null,
    subsecKnown: Boolean(partial.subsecKnown),
    mtimeMs: partial.mtimeMs || 0,
    birthtimeMs: partial.birthtimeMs || 0,
    size: partial.size || 10,
  };
}

test("拍摄时间按亚秒和整秒两种精度比较", () => {
  const second = Date.UTC(2024, 0, 2, 3, 4, 5);
  const knownA = file({ path: "a", name: "a.jpg", captureMs: second + 100, subsecKnown: true });
  const knownB = file({ path: "b", name: "b.jpg", captureMs: second + 800, subsecKnown: true });
  const loose = file({ path: "c", name: "c.jpg", captureMs: second, subsecKnown: false });
  const later = file({ path: "d", name: "d.jpg", captureMs: second + 5000 + 100, subsecKnown: true });
  const laterLoose = file({ path: "e", name: "e.jpg", captureMs: second + 5000, subsecKnown: false });
  assert.equal(sameCapture(knownA, knownB, 0), false);
  assert.equal(sameCapture(knownA, loose, 0), true);
  assert.equal(sameCapture(knownA, knownB, 1), true);
  const { groups } = clusterByCapture([knownA, knownB, loose, later, laterLoose], 0);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].map((item) => item.path).sort(), ["d", "e"]);
});

test("默认保留没有副本标记且路径更短的文件", () => {
  const ordered = orderForKeep([
    file({ path: "D:\\short\\IMG_1 (1).jpg", name: "IMG_1 (1).jpg", mtimeMs: 1 }),
    file({ path: "D:\\photos\\trip\\IMG_1.jpg", name: "IMG_1.jpg", mtimeMs: 9 }),
    file({ path: "D:\\z\\IMG_1.jpg", name: "IMG_1.jpg", mtimeMs: 8 }),
  ]);
  assert.equal(ordered[0].path, "D:\\z\\IMG_1.jpg");
  assert.equal(ordered[2].name, "IMG_1 (1).jpg");
});

test("标出原始文件和后来复制的文件", () => {
  const files = [
    file({ path: "D:\\相册\\相机胶卷\\IMG_1 (1).jpg", name: "IMG_1 (1).jpg", mtimeMs: 1, birthtimeMs: 50 }),
    file({ path: "D:\\相册\\个人收藏\\IMG_1.jpg", name: "IMG_1.jpg", mtimeMs: 1, birthtimeMs: 10 }),
    file({ path: "E:\\备份\\IMG_1.jpg", name: "IMG_1.jpg", mtimeMs: 1, birthtimeMs: 10_000 }),
    file({ path: "E:\\同时\\IMG_1.jpg", name: "IMG_1.jpg", mtimeMs: 1, birthtimeMs: 500 }),
  ];
  markOrigins(files);
  assert.equal(files.find((item) => item.path.includes("个人收藏")).origin, "original");
  assert.equal(files.find((item) => item.name.includes("(1)")).origin, "copy");
  assert.equal(files.find((item) => item.path.startsWith("E:\\备份")).origin, "copy");
  assert.equal(files.find((item) => item.path.startsWith("E:\\同时")).origin, "same");
});
