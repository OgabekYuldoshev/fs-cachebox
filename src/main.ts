/** biome-ignore-all lint/suspicious/noControlCharactersInRegex: <explanation> */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { readFile, writeFile, stat, rm } from "node:fs/promises";
import { gzipSync, gunzipSync } from "node:zlib";
import path, { join } from "node:path";
import { parse, stringify } from "flatted";
import { EventEmitter } from "node:events";

/**
 * Custom error class for cache operations
 */
export class CacheError extends Error {
  constructor(
    message: string,
    public operation: string,
    public key?: string,
    public originalError?: Error
  ) {
    super(message);
    this.name = "CacheError";
    if (originalError?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalError.stack}`;
    }
  }
}

/**
 * Enhanced configuration options for CacheBox initialization
 */
export interface CacheBoxOptions {
  /** Directory path where cache files will be stored. Defaults to '.cache' */
  cacheDir?: string;
  /** Enable automatic compression for cached values. Defaults to false */
  enableCompression?: boolean;
  /** Minimum size (in bytes) before compression kicks in. Defaults to 1024 */
  compressionThreshold?: number;
  /** Compression level (1-9, where 9 is best compression). Defaults to 6 */
  compressionLevel?: number;
  /** Maximum number of cache entries. Defaults to unlimited */
  maxSize?: number;
  /** Maximum size per cache file in bytes. Defaults to 50MB */
  maxFileSize?: number;
  /** Default TTL for entries in milliseconds. Defaults to 0 (no expiration) */
  defaultTTL?: number;
  /** Auto-cleanup interval in milliseconds. Defaults to 300000 (5 minutes) */
  cleanupInterval?: number;
  /** Enable automatic cleanup of expired entries. Defaults to true */
  enableAutoCleanup?: boolean;
  /** Enable detailed logging. Defaults to false */
  enableLogging?: boolean;
}

/**
 * Cache entry metadata
 */
interface CacheEntry {
  ttl: number;
  compressed: boolean;
  size: number;
  created: number;
  accessed: number;
}

/**
 * Event types emitted by CacheBox
 */
export interface CacheBoxEvents {
  /** Emitted when cache is initialized and ready */
  ready: { entriesLoaded: number; cacheDir: string };
  /** Emitted when cache data is modified */
  change: { operation: string; key: string; value?: any };
  /** Emitted when any error occurs */
  error: CacheError;
  /** Emitted when cache entry expires */
  expire: { key: string; ttl: number };
  /** Emitted when cache is cleared */
  clear: { entriesRemoved: number };
  /** Emitted during cleanup operations */
  cleanup: { expired: number; removed: number };
}
type EventMapToTuplePayload<T> = {
  [K in keyof T]: [T[K]];
};
/**
 * Enhanced file-based cache system with comprehensive features
 *
 * Features:
 * - Async and sync operations
 * - Compression support with configurable thresholds
 * - Key validation and security
 * - Event-driven architecture
 * - Performance monitoring
 * - Automatic cleanup
 * - Batch operations
 * - Type safety with generics
 * - LRU eviction when size limits are reached
 */
export class CacheBox extends EventEmitter<
  EventMapToTuplePayload<CacheBoxEvents>
> {
  private _cache = new Map<string, CacheEntry>();
  private _cacheDir = ".cache";
  private _enableCompression = false;
  private _compressionThreshold = 1024;
  private _compressionLevel = 6;
  private _maxSize?: number;
  private _maxFileSize = 50 * 1024 * 1024; // 50MB
  private _defaultTTL = 0;
  private _cleanupInterval = 5 * 60 * 1000; // 5 minutes
  private _enableAutoCleanup = true;
  private _enableLogging = false;
  private _cleanupTimer?: NodeJS.Timeout;
  private _stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    errors: 0,
  };

  constructor(options?: CacheBoxOptions) {
    super();
    this.setMaxListeners(100); // Increase listener limit for high-usage scenarios

    // Apply configuration
    if (options?.cacheDir) this._cacheDir = options.cacheDir;
    if (options?.enableCompression !== undefined)
      this._enableCompression = options.enableCompression;
    if (options?.compressionThreshold)
      this._compressionThreshold = options.compressionThreshold;
    if (options?.compressionLevel) {
      this._compressionLevel = Math.max(
        1,
        Math.min(9, options.compressionLevel)
      );
    }
    if (options?.maxSize) this._maxSize = options.maxSize;
    if (options?.maxFileSize) this._maxFileSize = options.maxFileSize;
    if (options?.defaultTTL) this._defaultTTL = options.defaultTTL;
    if (options?.cleanupInterval)
      this._cleanupInterval = options.cleanupInterval;
    if (options?.enableAutoCleanup !== undefined)
      this._enableAutoCleanup = options.enableAutoCleanup;
    if (options?.enableLogging !== undefined)
      this._enableLogging = options.enableLogging;

    // Initialize cache
    this.load();
  }

  /**
   * Validates cache key for security and filesystem compatibility
   */
  private validateKey(key: string): boolean {
    if (!key || typeof key !== "string") return false;
    if (key.length === 0 || key.length > 255) return false;

    // Prevent directory traversal
    if (key.includes("..") || key.includes("/") || key.includes("\\"))
      return false;

    // Invalid filename characters
    const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
    if (invalidChars.test(key)) return false;

    // Reserved Windows filenames
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    if (reservedNames.test(key)) return false;

    return true;
  }

  /**
   * Logs messages if logging is enabled
   */
  private log(
    level: "info" | "warn" | "error",
    message: string,
    extra?: any
  ): void {
    if (this._enableLogging) {
      console[level](`[CacheBox] ${message}`, extra || "");
    }
  }

  /**
   * Serializes and optionally compresses data
   */
  private serialize(value: any): {
    data: string;
    compressed: boolean;
    size: number;
  } {
    try {
      const serialized = stringify(value);
      const originalSize = Buffer.byteLength(serialized, "utf8");

      // Check file size limits
      if (originalSize > this._maxFileSize) {
        throw new CacheError(
          `Value size (${originalSize} bytes) exceeds maximum file size (${this._maxFileSize} bytes)`,
          "serialize"
        );
      }

      // Apply compression if enabled and threshold is met
      if (
        this._enableCompression &&
        originalSize > this._compressionThreshold
      ) {
        try {
          const compressed = gzipSync(serialized, {
            level: this._compressionLevel,
          });
          const base64 = compressed.toString("base64");

          // Only use compression if it actually saves space
          if (base64.length < serialized.length) {
            return { data: base64, compressed: true, size: base64.length };
          }
        } catch (compressionError) {
          this.log(
            "warn",
            "Compression failed, storing uncompressed",
            compressionError
          );
        }
      }

      return { data: serialized, compressed: false, size: originalSize };
    } catch (error) {
      throw new CacheError(
        "Serialization failed",
        "serialize",
        undefined,
        error as Error
      );
    }
  }

  /**
   * Deserializes and optionally decompresses data
   */
  private deserialize<T>(data: string, compressed: boolean): T {
    try {
      if (compressed) {
        const buffer = Buffer.from(data, "base64");
        const decompressed = gunzipSync(buffer).toString("utf8");
        return parse(decompressed) as T;
      }
      return parse(data) as T;
    } catch (error) {
      throw new CacheError(
        "Deserialization failed",
        "deserialize",
        undefined,
        error as Error
      );
    }
  }

  /**
   * Parses filename to extract metadata
   */
  private parseFileName(
    fileName: string
  ): { key: string; ttl: number; compressed: boolean } | null {
    const match = fileName.match(/^(.+)_(\d+)(_c)?$/);

    if (!match) return null;
    const key = match[1] || "";

    return {
      key,
      ttl: Number(match[2]),
      compressed: Boolean(match[3]),
    };
  }

  /**
   * Generates filename with metadata
   */
  private generateFileName(
    key: string,
    ttl: number,
    compressed: boolean
  ): string {
    return `${key}_${ttl}${compressed ? "_c" : ""}`;
  }

  /**
   * Removes expired entries and enforces size limits
   */
  private performCleanup(): void {
    try {
      const now = Date.now();
      let expired = 0;
      let removed = 0;

      // Remove expired entries
      for (const [key, entry] of this._cache.entries()) {
        if (entry.ttl !== 0 && entry.ttl < now) {
          this.delete(key);
          expired++;
          this.emit("expire", { key, ttl: entry.ttl });
        }
      }

      // Enforce size limits with LRU eviction
      if (this._maxSize && this._cache.size > this._maxSize) {
        const sortedEntries = Array.from(this._cache.entries()).sort(
          ([, a], [, b]) => a.accessed - b.accessed
        );

        const toRemove = sortedEntries.slice(
          0,
          this._cache.size - this._maxSize
        );
        for (const [key] of toRemove) {
          this.delete(key);
          removed++;
        }
      }

      if (expired > 0 || removed > 0) {
        this.emit("cleanup", { expired, removed });
        this.log(
          "info",
          `Cleanup completed: ${expired} expired, ${removed} evicted`
        );
      }
    } catch (error) {
      this.emitError("cleanup", undefined, error as Error);
    }
  }

  /**
   * Starts automatic cleanup timer
   */
  private startAutoCleanup(): void {
    if (this._enableAutoCleanup && this._cleanupInterval > 0) {
      this._cleanupTimer = setInterval(() => {
        this.performCleanup();
      }, this._cleanupInterval);
    }
  }

  /**
   * Emits error events with consistent formatting
   */
  private emitError(operation: string, key?: string, error?: Error): void {
    this._stats.errors++;

    const cacheError =
      error instanceof CacheError
        ? error
        : new CacheError(
            error?.message || "Unknown error",
            operation,
            key,
            error
          );

    this.log(
      "error",
      `Error in ${operation}${key ? ` for key "${key}"` : ""}`,
      cacheError
    );

    if (this.listenerCount("error") > 0) {
      this.emit("error", cacheError);
    }
  }

  /**
   * Initializes the cache system
   */
  private load(): void {
    try {
      const cacheDir = path.resolve(this._cacheDir);

      if (!existsSync(cacheDir)) {
        mkdirSync(cacheDir, { recursive: true });
      }

      this.syncMemoryCache();
      this.startAutoCleanup();

      process.nextTick(() => {
        this.emit("ready", {
          entriesLoaded: this._cache.size,
          cacheDir: this._cacheDir,
        });
      });

      this.log("info", `Cache initialized with ${this._cache.size} entries`);
    } catch (error) {
      this.emitError("initialization", undefined, error as Error);
    }
  }

  /**
   * Synchronizes memory cache with filesystem
   */
  private syncMemoryCache(): void {
    try {
      const cacheDir = path.resolve(this._cacheDir);
      if (!existsSync(cacheDir)) return;

      const files = readdirSync(cacheDir);
      const newCache = new Map<string, CacheEntry>();
      const now = Date.now();

      files.forEach((file) => {
        try {
          const parsed = this.parseFileName(file);
          if (parsed) {
            const { key, ttl, compressed } = parsed;

            // Skip expired entries
            if (ttl !== 0 && ttl < now) {
              rmSync(join(cacheDir, file));
              return;
            }

            // Get file stats
            const filePath = join(cacheDir, file);
            const stats = statSync(filePath);

            newCache.set(key, {
              ttl,
              compressed,
              size: stats.size,
              created: stats.ctimeMs,
              accessed: stats.atimeMs,
            });
          }
        } catch (error) {
          this.log("warn", `Failed to process file ${file}`, error);
        }
      });

      this._cache = newCache;
    } catch (error) {
      throw new CacheError(
        "Failed to sync memory cache",
        "sync",
        undefined,
        error as Error
      );
    }
  }

  // =========================
  // PUBLIC SYNC METHODS
  // =========================

  /**
   * Checks if a cache key exists and is not expired
   */
  public has(key: string): boolean {
    if (!this.validateKey(key)) {
      this.emitError("has", key, new Error("Invalid key format"));
      return false;
    }

    if (!this._cache.has(key)) return false;

    const entry = this._cache.get(key)!;

    if (entry.ttl !== 0 && entry.ttl < Date.now()) {
      this.delete(key);
      return false;
    }

    return true;
  }

  /**
   * Retrieves a cached value by key
   */
  public get<T>(key: string): T | null {
    if (!this.validateKey(key)) {
      this.emitError("get", key, new Error("Invalid key format"));
      return null;
    }

    try {
      if (!this._cache.has(key)) {
        this._stats.misses++;
        return null;
      }

      const entry = this._cache.get(key)!;

      // Check expiration
      if (entry.ttl !== 0 && entry.ttl < Date.now()) {
        this.delete(key);
        this._stats.misses++;
        return null;
      }

      const fileName = this.generateFileName(key, entry.ttl, entry.compressed);
      const filePath = join(this._cacheDir, fileName);

      if (!existsSync(filePath)) {
        this._cache.delete(key);
        this._stats.misses++;
        return null;
      }

      const content = readFileSync(filePath, "utf8");
      const result = this.deserialize<T>(content, entry.compressed);

      // Update access time
      entry.accessed = Date.now();
      this._stats.hits++;

      return result;
    } catch (error) {
      this.emitError("get", key, error as Error);
      this._stats.misses++;
      return null;
    }
  }

  /**
   * Stores a value in the cache
   */
  public set(key: string, value: any, ttl?: number): boolean {
    if (!this.validateKey(key)) {
      this.emitError("set", key, new Error("Invalid key format"));
      return false;
    }

    try {
      const effectiveTTL = ttl ?? this._defaultTTL;
      const fileTtl = effectiveTTL === 0 ? 0 : Date.now() + effectiveTTL;
      const { data, compressed, size } = this.serialize(value);

      const fileName = this.generateFileName(key, fileTtl, compressed);
      const filePath = join(this._cacheDir, fileName);

      // Remove old entry if it exists
      if (this._cache.has(key)) {
        this.delete(key);
      }

      writeFileSync(filePath, data);

      const now = Date.now();
      this._cache.set(key, {
        ttl: fileTtl,
        compressed,
        size,
        created: now,
        accessed: now,
      });

      this._stats.sets++;
      this.emit("change", { operation: "set", key, value });

      // Check size limits after setting
      if (this._maxSize && this._cache.size > this._maxSize) {
        this.performCleanup();
      }

      return true;
    } catch (error) {
      this.emitError("set", key, error as Error);
      return false;
    }
  }

  /**
   * Removes a cache entry
   */
  public delete(key: string): boolean {
    if (!this.validateKey(key)) return false;

    try {
      if (!this._cache.has(key)) return true;

      const entry = this._cache.get(key)!;
      const fileName = this.generateFileName(key, entry.ttl, entry.compressed);
      const filePath = join(this._cacheDir, fileName);

      if (existsSync(filePath)) {
        rmSync(filePath);
      }

      this._cache.delete(key);
      this._stats.deletes++;
      this.emit("change", { operation: "delete", key });

      return true;
    } catch (error) {
      this.emitError("delete", key, error as Error);
      return false;
    }
  }

  /**
   * Clears all cache entries
   */
  public clear(): boolean {
    try {
      const cacheDir = path.resolve(this._cacheDir);
      const entriesBefore = this._cache.size;

      if (existsSync(cacheDir)) {
        const files = readdirSync(cacheDir);
        files.forEach((file) => rmSync(join(cacheDir, file)));
      }

      this._cache.clear();
      this.emit("clear", { entriesRemoved: entriesBefore });
      this.log("info", `Cache cleared: ${entriesBefore} entries removed`);

      return true;
    } catch (error) {
      this.emitError("clear", undefined, error as Error);
      return false;
    }
  }

  /**
   * Batch set multiple entries
   */
  public setMany(entries: Array<{ key: string; value: any; ttl?: number }>): {
    success: number;
    failed: number;
    results: boolean[];
  } {
    const results: boolean[] = [];
    let success = 0;
    let failed = 0;

    for (const { key, value, ttl } of entries) {
      const result = this.set(key, value, ttl);
      results.push(result);
      if (result) success++;
      else failed++;
    }

    this.emit("change", {
      operation: "setMany",
      key: `${entries.length} entries`,
    });
    return { success, failed, results };
  }

  /**
   * Batch get multiple entries
   */
  public getMany<T>(
    keys: string[]
  ): Array<{ key: string; value: T | null; found: boolean }> {
    return keys.map((key) => {
      const value = this.get<T>(key);
      return { key, value, found: value !== null };
    });
  }

  // =========================
  // PUBLIC ASYNC METHODS
  // =========================

  /**
   * Async version of get method
   */
  public async getAsync<T>(key: string): Promise<T | null> {
    if (!this.validateKey(key)) {
      this.emitError("getAsync", key, new Error("Invalid key format"));
      return null;
    }

    try {
      if (!this._cache.has(key)) {
        this._stats.misses++;
        return null;
      }

      const entry = this._cache.get(key)!;

      if (entry.ttl !== 0 && entry.ttl < Date.now()) {
        await this.deleteAsync(key);
        this._stats.misses++;
        return null;
      }

      const fileName = this.generateFileName(key, entry.ttl, entry.compressed);
      const filePath = join(this._cacheDir, fileName);

      try {
        await stat(filePath);
      } catch {
        this._cache.delete(key);
        this._stats.misses++;
        return null;
      }

      const content = await readFile(filePath, "utf8");
      const result = this.deserialize<T>(content, entry.compressed);

      entry.accessed = Date.now();
      this._stats.hits++;

      return result;
    } catch (error) {
      this.emitError("getAsync", key, error as Error);
      this._stats.misses++;
      return null;
    }
  }

  /**
   * Async version of set method
   */
  public async setAsync(
    key: string,
    value: any,
    ttl?: number
  ): Promise<boolean> {
    if (!this.validateKey(key)) {
      this.emitError("setAsync", key, new Error("Invalid key format"));
      return false;
    }

    try {
      const effectiveTTL = ttl ?? this._defaultTTL;
      const fileTtl = effectiveTTL === 0 ? 0 : Date.now() + effectiveTTL;
      const { data, compressed, size } = this.serialize(value);

      const fileName = this.generateFileName(key, fileTtl, compressed);
      const filePath = join(this._cacheDir, fileName);

      if (this._cache.has(key)) {
        await this.deleteAsync(key);
      }

      await writeFile(filePath, data);

      const now = Date.now();
      this._cache.set(key, {
        ttl: fileTtl,
        compressed,
        size,
        created: now,
        accessed: now,
      });

      this._stats.sets++;
      this.emit("change", { operation: "setAsync", key, value });

      if (this._maxSize && this._cache.size > this._maxSize) {
        this.performCleanup();
      }

      return true;
    } catch (error) {
      this.emitError("setAsync", key, error as Error);
      return false;
    }
  }

  /**
   * Async version of delete method
   */
  public async deleteAsync(key: string): Promise<boolean> {
    if (!this.validateKey(key)) return false;

    try {
      if (!this._cache.has(key)) return true;

      const entry = this._cache.get(key)!;
      const fileName = this.generateFileName(key, entry.ttl, entry.compressed);
      const filePath = join(this._cacheDir, fileName);

      try {
        await rm(filePath);
      } catch {
        // File might not exist, which is fine
      }

      this._cache.delete(key);
      this._stats.deletes++;
      this.emit("change", { operation: "deleteAsync", key });

      return true;
    } catch (error) {
      this.emitError("deleteAsync", key, error as Error);
      return false;
    }
  }

  /**
   * Async batch operations
   */
  public async setManyAsync(
    entries: Array<{ key: string; value: any; ttl?: number }>
  ): Promise<{ success: number; failed: number; results: boolean[] }> {
    const promises = entries.map(({ key, value, ttl }) =>
      this.setAsync(key, value, ttl)
    );

    const results = await Promise.all(promises);
    const success = results.filter((r) => r).length;
    const failed = results.length - success;

    this.emit("change", {
      operation: "setManyAsync",
      key: `${entries.length} entries`,
    });
    return { success, failed, results };
  }

  public async getManyAsync<T>(
    keys: string[]
  ): Promise<Array<{ key: string; value: T | null; found: boolean }>> {
    const promises = keys.map(async (key) => {
      const value = await this.getAsync<T>(key);
      return { key, value, found: value !== null };
    });

    return Promise.all(promises);
  }

  // =========================
  // UTILITY & STATS METHODS
  // =========================

  /**
   * Returns current cache size
   */
  public size(): number {
    return this._cache.size;
  }

  /**
   * Returns all valid cache keys
   */
  public keys(): string[] {
    const now = Date.now();
    return Array.from(this._cache.entries())
      .filter(([, entry]) => entry.ttl === 0 || entry.ttl > now)
      .map(([key]) => key);
  }

  /**
   * Returns comprehensive cache statistics
   */
  public stats() {
    const now = Date.now();
    const validEntries = Array.from(this._cache.entries()).filter(
      ([, entry]) => entry.ttl === 0 || entry.ttl > now
    );

    const compressionStats = this.compressionStats();
    const totalSize = validEntries.reduce(
      (sum, [, entry]) => sum + entry.size,
      0
    );

    return {
      entries: validEntries.length,
      memoryEntries: this._cache.size,
      totalSize,
      averageSize:
        validEntries.length > 0
          ? Math.round(totalSize / validEntries.length)
          : 0,
      cacheDir: this._cacheDir,
      configuration: {
        maxSize: this._maxSize,
        maxFileSize: this._maxFileSize,
        defaultTTL: this._defaultTTL,
        compressionEnabled: this._enableCompression,
        compressionThreshold: this._compressionThreshold,
        compressionLevel: this._compressionLevel,
      },
      performance: {
        hits: this._stats.hits,
        misses: this._stats.misses,
        hitRate:
          this._stats.hits + this._stats.misses > 0
            ? this._stats.hits / (this._stats.hits + this._stats.misses)
            : 0,
        sets: this._stats.sets,
        deletes: this._stats.deletes,
        errors: this._stats.errors,
      },
      compression: compressionStats,
    };
  }

  /**
   * Returns compression-specific statistics
   */
  public compressionStats() {
    const entries = Array.from(this._cache.values());
    const compressed = entries.filter((entry) => entry.compressed).length;
    const total = entries.length;

    return {
      totalEntries: total,
      compressedEntries: compressed,
      uncompressedEntries: total - compressed,
      compressionRatio: total > 0 ? compressed / total : 0,
      enabled: this._enableCompression,
      threshold: this._compressionThreshold,
      level: this._compressionLevel,
    };
  }

  /**
   * Manually trigger cleanup
   */
  public cleanup(): { expired: number; removed: number } {
    const before = this._cache.size;
    this.performCleanup();
    const after = this._cache.size;

    return {
      expired: 0, // Will be emitted in cleanup event
      removed: before - after,
    };
  }

  /**
   * Stops auto-cleanup timer and closes cache
   */
  public close(): void {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = undefined;
    }

    this.removeAllListeners();
    this.log("info", "Cache closed");
  }

  /**
   * Resets all statistics
   */
  public resetStats(): void {
    this._stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0,
    };
  }
}
