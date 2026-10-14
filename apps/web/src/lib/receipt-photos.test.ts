import assert from "node:assert/strict";
import test from "node:test";
import { appendExtraPhotos, receiptPhotos, removeExtraPhoto, replaceMainPhoto } from "./receipt-photos";

test("main photo first, extras after, blanks and repeats dropped", () => {
  assert.deepEqual(receiptPhotos("a.jpg", ["b.jpg", " ", "a.jpg", "b.jpg", null, "c.jpg"]), [
    { path: "a.jpg", main: true },
    { path: "b.jpg", main: false },
    { path: "c.jpg", main: false },
  ]);
  assert.deepEqual(receiptPhotos(null, null), []);
  assert.deepEqual(receiptPhotos("", ["x.jpg"]), [{ path: "x.jpg", main: false }]);
});

test("append keeps order and skips the main photo and existing extras", () => {
  assert.deepEqual(appendExtraPhotos("a.jpg", ["b.jpg"], ["c.jpg", "a.jpg", "b.jpg", "d.jpg"]), ["b.jpg", "c.jpg", "d.jpg"]);
  assert.deepEqual(appendExtraPhotos(null, null, ["c.jpg"]), ["c.jpg"]);
});

test("remove drops only that extra", () => {
  assert.deepEqual(removeExtraPhoto("a.jpg", ["b.jpg", "c.jpg"], "b.jpg"), ["c.jpg"]);
  assert.deepEqual(removeExtraPhoto("a.jpg", ["b.jpg"], "a.jpg"), ["b.jpg"]);
});

test("a new main photo keeps the old main as the first extra", () => {
  assert.deepEqual(replaceMainPhoto("a.jpg", ["b.jpg"], "n.jpg"), ["a.jpg", "b.jpg"]);
  assert.deepEqual(replaceMainPhoto(null, ["b.jpg"], "n.jpg"), ["b.jpg"]);
  assert.deepEqual(replaceMainPhoto("a.jpg", ["n.jpg", "b.jpg"], "n.jpg"), ["a.jpg", "b.jpg"]);
  assert.deepEqual(replaceMainPhoto("n.jpg", ["b.jpg"], "n.jpg"), ["b.jpg"]);
});
