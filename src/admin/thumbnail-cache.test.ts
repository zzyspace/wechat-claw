import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import sharp from "sharp";
import { ThumbnailCache, ThumbnailBusyError } from "./thumbnail-cache.js";
import { generateHeicThumbnail, isHeicDecoderUnavailable } from "./heic-thumbnail.js";

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

test("native HEIC fallback only recognizes the missing HEVC decoder error", () => {
  assert.equal(isHeicDecoderUnavailable(new Error(
    "heif: Unsupported feature: Support for this compression format has not been built in: HEVC (11.6003)",
  )), true);
  for (const error of [
    new Error("Input file is missing"),
    new Error("Input image exceeds pixel limit"),
    new Error("heif: Invalid input: No 'hvcC' box"),
    new Error("Support for this compression format has not been built in: AV1"),
    "Support for this compression format has not been built in: HEVC",
    null,
  ]) {
    assert.equal(isHeicDecoderUnavailable(error), false);
  }
});

test("native HEIC fallback bounds decoded output and preserves source bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expense-heic-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  // A shell-like filename also verifies the source is passed as one execFile argument.
  const source = path.join(root, "source $(touch never-created); image.heic");
  const original = crypto.randomBytes(128);
  await fs.writeFile(source, original);
  const sourceHash = crypto.createHash("sha256").update(original).digest("hex");

  for (const [width, height, expectedWidth, expectedHeight] of [
    [480, 960, 120, 240],
    [100, 50, 100, 50],
  ]) {
    const decoded = await sharp({ create: { width, height, channels: 3, background: "blue" } }).png().toBuffer();
    const metadata = await sharp(decoded).metadata();
    let temporaryDirectory = "";
    let calls = 0;
    const result = await generateHeicThumbnail(source, {
      readMetadata: async (file) => {
        assert.equal(file, source);
        return { ...metadata, format: "heif", compression: "hevc" };
      },
      runThumbnailer: async (file, args, options) => {
        calls += 1;
        assert.equal(file, "/usr/bin/heif-thumbnailer");
        assert.deepEqual(args.slice(0, 4), ["-s", "240", "-p", source]);
        assert.equal(args.length, 5);
        assert.deepEqual(options, { timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
        temporaryDirectory = path.dirname(args[4]);
        assert.equal((await fs.stat(temporaryDirectory)).mode & 0o777, 0o700);
        await fs.writeFile(args[4], decoded);
      },
    });
    assert.equal(calls, 1);
    const thumbnail = await sharp(result).metadata();
    assert.equal(thumbnail.format, "webp");
    assert.equal(thumbnail.width, expectedWidth);
    assert.equal(thumbnail.height, expectedHeight);
    await assert.rejects(fs.stat(temporaryDirectory), { code: "ENOENT" });
    assert.equal(crypto.createHash("sha256").update(await fs.readFile(source)).digest("hex"), sourceHash);
  }
});

test("native HEIC fallback rejects other codecs and over-limit images before invoking decoder", async () => {
  const png = await sharp({ create: { width: 100, height: 100, channels: 3, background: "red" } }).png().toBuffer();
  const metadata = { ...await sharp(png).metadata(), format: "heif" as const, compression: "hevc" as const };
  for (const invalid of [
    { ...metadata, format: "png" as const },
    { ...metadata, compression: "av1" as const },
    { ...metadata, width: 40_000_001, height: 1 },
    { ...metadata, width: 0 },
    { ...metadata, height: 0 },
    { ...metadata, width: -1 },
    { ...metadata, width: Number.NaN },
    { ...metadata, width: 1.5 },
  ]) {
    let decoderCalls = 0;
    await assert.rejects(generateHeicThumbnail("unused.heic", {
      readMetadata: async () => invalid,
      runThumbnailer: async () => { decoderCalls += 1; },
    }), /requires an HEVC-compressed HEIF image|pixel limit|invalid dimensions/);
    assert.equal(decoderCalls, 0);
  }
  const corruptInput = new Error("heif: Invalid input: No 'meta' box");
  await assert.rejects(generateHeicThumbnail("corrupt.heic", {
    readMetadata: async () => { throw corruptInput; },
    runThumbnailer: async () => { assert.fail("Corrupt input must never reach native decoder"); },
  }), (error) => error === corruptInput);
});

test("native HEIC fallback cleans intermediate files on decoder and output failures", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "expense-heic-failure-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.heic");
  const original = crypto.randomBytes(128);
  await fs.writeFile(source, original);
  const png = await sharp({ create: { width: 20, height: 40, channels: 3, background: "green" } }).png().toBuffer();
  const metadata = { ...await sharp(png).metadata(), format: "heif" as const, compression: "hevc" as const };
  const decoderFailure = new Error("heif-thumbnailer exited with code 1");
  const timeoutFailure = Object.assign(new Error("heif-thumbnailer timed out"), { killed: true, signal: "SIGTERM" });

  for (const failure of [decoderFailure, timeoutFailure, undefined]) {
    let temporaryDirectory = "";
    await assert.rejects(generateHeicThumbnail(source, {
      readMetadata: async () => metadata,
      runThumbnailer: async (_file, args) => {
        temporaryDirectory = path.dirname(args[4]);
        await fs.writeFile(args[4], "invalid or partial PNG");
        if (failure) throw failure;
      },
    }), failure ? (error) => error === failure : /unsupported image format/);
    assert.ok(temporaryDirectory);
    await assert.rejects(fs.stat(temporaryDirectory), { code: "ENOENT" });
    assert.deepEqual(await fs.readFile(source), original);
  }
});
