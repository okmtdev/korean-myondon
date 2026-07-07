import { test } from "node:test";
import assert from "node:assert/strict";
import { FixedChunker, MjpegExtractor } from "../src/capture.ts";

test("FixedChunker: 分割・結合されて届いても固定長で切り出す", () => {
  const chunker = new FixedChunker(4);
  assert.deepEqual(chunker.push(Buffer.from([1, 2])), []);

  const first = chunker.push(Buffer.from([3, 4, 5]));
  assert.equal(first.length, 1);
  assert.deepEqual([...first[0]], [1, 2, 3, 4]); // 残り [5]

  const second = chunker.push(Buffer.from([6, 7, 8, 9, 10, 11]));
  assert.equal(second.length, 1);
  assert.deepEqual([...second[0]], [5, 6, 7, 8]); // 残り [9,10,11]

  const third = chunker.push(Buffer.from([12]));
  assert.equal(third.length, 1);
  assert.deepEqual([...third[0]], [9, 10, 11, 12]);
});

test("MjpegExtractor: チャンク境界をまたいだ JPEG を切り出す", () => {
  const jpegA = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9]);
  const jpegB = Buffer.from([0xff, 0xd8, 0x03, 0xff, 0xd9]);
  const stream = Buffer.concat([Buffer.from([0x00, 0x11]), jpegA, jpegB]); // 先頭にゴミ

  const extractor = new MjpegExtractor();
  const part1 = stream.subarray(0, 5); // jpegA の途中まで
  const part2 = stream.subarray(5);

  assert.deepEqual(extractor.push(part1), []);
  const frames = extractor.push(part2);
  assert.equal(frames.length, 2);
  assert.deepEqual([...frames[0]], [...jpegA]);
  assert.deepEqual([...frames[1]], [...jpegB]);
});
