import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { generateHeicThumbnail, isHeicDecoderUnavailable } from "./heic-thumbnail.js";

const CACHE_VERSION = "webp-240-q60-v1";
const CACHE_FILE = /^[a-f0-9]{64}\.webp$/;

export class ThumbnailBusyError extends Error {}

/** Derived files only. Callers must authorize and verify the source on every request. */
export class ThumbnailCache {
  private readonly pending = new Map<string, Promise<Buffer>>();
  private readonly files = new Map<string, { size: number; created: number }>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;
  private initialized?: Promise<void>;
  private maintenance: Promise<void> = Promise.resolve();

  constructor(
    private readonly directory: string,
    private readonly limits = { concurrency: 2, queue: 32, bytes: 128 * 1024 * 1024, ageMs: 30 * 86400_000 },
  ) {}

  private initialize() {
    return this.initialized ??= (async () => {
      await fs.mkdir(this.directory, { recursive: true });
      for (const name of await fs.readdir(this.directory)) {
        if (/^[a-f0-9]{64}\.webp\.[a-f0-9-]+\.tmp$/.test(name)) {
          const temporary = path.join(this.directory, name);
          if (Date.now() - (await fs.stat(temporary)).mtimeMs > 86400_000) await fs.rm(temporary, { force: true });
          continue;
        }
        if (!CACHE_FILE.test(name)) continue;
        const stat = await fs.stat(path.join(this.directory, name));
        this.files.set(name, { size: stat.size, created: stat.mtimeMs });
      }
      await this.trim();
    })();
  }

  private trim() {
    const operation = this.maintenance.then(async () => {
      let bytes = [...this.files.values()].reduce((sum, file) => sum + file.size, 0);
      const oldest = [...this.files].sort((a, b) => a[1].created - b[1].created);
      for (const [name, file] of oldest) {
        if (bytes <= this.limits.bytes && Date.now() - file.created <= this.limits.ageMs) break;
        await fs.rm(path.join(this.directory, name), { force: true });
        this.files.delete(name);
        bytes -= file.size;
      }
    });
    this.maintenance = operation.catch(() => {});
    return operation;
  }

  async get(sourcePath: string, sourceHash: string): Promise<Buffer> {
    // Also invalidates stale derived files if a source is replaced outside the importer.
    const stat = await fs.stat(sourcePath);
    const name = crypto.createHash("sha256")
      .update(`${CACHE_VERSION}:${sourceHash}:${stat.size}:${stat.mtimeMs}`).digest("hex") + ".webp";
    const existing = this.pending.get(name);
    if (existing) return existing;
    if (this.pending.size >= this.limits.concurrency + this.limits.queue) {
      throw new ThumbnailBusyError("Thumbnail queue is full");
    }
    const task = this.generate(sourcePath, name);
    this.pending.set(name, task);
    try {
      return await task;
    } finally {
      this.pending.delete(name);
    }
  }

  private async generate(sourcePath: string, name: string): Promise<Buffer> {
    if (this.active >= this.limits.concurrency) await new Promise<void>((resolve) => this.waiters.push(resolve));
    else this.active += 1;
    try {
      await this.initialize();
      const target = path.join(this.directory, name);
      const cached = this.files.get(name);
      if (cached && Date.now() - cached.created <= this.limits.ageMs) {
        try { return await fs.readFile(target); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      let buffer: Buffer;
      try {
        buffer = await sharp(sourcePath, { limitInputPixels: 40_000_000, animated: false })
          .rotate().resize({ width: 240, height: 240, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 60 }).toBuffer();
      } catch (error) {
        if (!isHeicDecoderUnavailable(error)) throw error;
        buffer = await generateHeicThumbnail(sourcePath);
      }
      const temporary = path.join(this.directory, `${name}.${crypto.randomUUID()}.tmp`);
      try {
        await fs.writeFile(temporary, buffer, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, target);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      this.files.set(name, { size: buffer.length, created: Date.now() });
      await this.trim();
      return buffer;
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
