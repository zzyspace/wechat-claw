import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { ThumbnailCache, ThumbnailBusyError } from "./thumbnail-cache.js";

test("thumbnails preserve originals, coalesce requests and reuse disk cache", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expense-thumbnail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "original.png");
  const pixels = crypto.randomBytes(1200 * 900 * 3);
  await sharp(pixels, { raw: { width: 1200, height: 900, channels: 3 } }).png().toFile(source);
  const original = await fs.readFile(source);
  const hash = crypto.createHash("sha256").update(original).digest("hex");
  const directory = path.join(root, "cache");
  const cache = new ThumbnailCache(directory);
  const results = await Promise.all(Array.from({ length: 8 }, () => cache.get(source, hash)));
  assert.ok(results.every((result) => result.equals(results[0])));
  const metadata = await sharp(results[0]).metadata();
  assert.equal(metadata.format, "webp");
  assert.equal(metadata.width, 240);
  assert.equal(metadata.height, 180);
  assert.ok(results[0].length < original.length / 10);
  assert.deepEqual(await fs.readFile(source), original);
  const names = await fs.readdir(directory);
  assert.equal(names.length, 1);
  const cachedBefore = await fs.stat(path.join(directory, names[0]));
  assert.deepEqual(await new ThumbnailCache(directory).get(source, hash), results[0]);
  assert.equal((await fs.stat(path.join(directory, names[0]))).mtimeMs, cachedBefore.mtimeMs);
  await fs.rm(source);
  await assert.rejects(cache.get(source, hash), /ENOENT/);
});

test("cache cleanup removes expired/over-budget derived files and leaves unrelated files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expense-thumbnail-quota-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.png");
  await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } }).png().toFile(source);
  const directory = path.join(root, "cache");
  await fs.mkdir(directory);
  const expired = path.join(directory, `${"a".repeat(64)}.webp`);
  await fs.writeFile(expired, "expired");
  await fs.utimes(expired, new Date(0), new Date(0));
  await fs.writeFile(path.join(directory, "keep.txt"), "unrelated");
  const cache = new ThumbnailCache(directory, { concurrency: 1, queue: 1, bytes: 1, ageMs: 1000 });
  const result = await cache.get(source, "source-hash");
  assert.equal((await sharp(result).metadata()).width, 100);
  assert.deepEqual(await fs.readdir(directory), ["keep.txt"]);
  assert.ok(await fs.stat(source));
});

test("generation queue is bounded and a bad image does not block subsequent requests", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expense-thumbnail-queue-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.png");
  await sharp({ create: { width: 1000, height: 1000, channels: 3, background: "blue" } }).png().toFile(source);
  const cache = new ThumbnailCache(path.join(root, "cache"), { concurrency: 1, queue: 0, bytes: 1_000_000, ageMs: 86400_000 });
  const results = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => cache.get(source, `hash-${i}`)));
  assert.ok(results.some((result) => result.status === "fulfilled"));
  assert.ok(results.some((result) => result.status === "rejected" && result.reason instanceof ThumbnailBusyError));
  const bad = path.join(root, "bad.jpg");
  await fs.writeFile(bad, "invalid image");
  await assert.rejects(cache.get(bad, "bad"));
  assert.equal((await sharp(await cache.get(source, "valid")).metadata()).width, 240);
});
