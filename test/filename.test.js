import test from "node:test";
import assert from "node:assert/strict";
import { exactKey, isCopyName, normalizeKey } from "../src/filename.js";

test("去掉复制产生的文件名后缀", () => {
  assert.equal(normalizeKey("IMG_0001.jpg"), "img_0001");
  assert.equal(normalizeKey("IMG_0001 (1).jpg"), "img_0001");
  assert.equal(normalizeKey("IMG_0001(2).JPG"), "img_0001");
  assert.equal(normalizeKey("IMG_0001（1）.jpg"), "img_0001");
  assert.equal(normalizeKey("IMG_0001 - 副本.jpg"), "img_0001");
  assert.equal(normalizeKey("IMG_0001 - 副本 (2).jpg"), "img_0001");
  assert.equal(normalizeKey("IMG_0001 - Copy.jpg"), "img_0001");
  assert.equal(normalizeKey("IMG_0001 copy.jpg"), "img_0001");
  assert.equal(normalizeKey("IMG_0001 (1) (2).jpg"), "img_0001");
  assert.equal(normalizeKey("DSC_1234.NEF"), "dsc_1234");
  assert.equal(exactKey("IMG_0001 (1).jpg"), "img_0001 (1)");
  assert.equal(isCopyName("IMG_0001 (1).jpg"), true);
  assert.equal(isCopyName("IMG_0001 - 副本.jpg"), true);
  assert.equal(isCopyName("IMG_0001.jpg"), false);
});
