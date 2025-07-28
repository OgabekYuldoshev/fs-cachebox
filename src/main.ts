import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import path, { join } from "node:path";
import { parse, stringify } from "flatted";
import { FILENAME_TIME_EXTRACTOR } from "./constants";
import { Mitt } from "./event-listener";

/**
 * Configuration options for CacheBox initialization
 */
export interface CacheBoxOptions {
	/** Directory path where cache files will be stored. Defaults to '.cache' */
	cacheDir?: string;
}

/**
 * Event types emitted by CacheBox
 */
type Events = {
	/** Emitted when any error occurs during cache operations */
	error: Error;
	/** Emitted when cache data is modified (set operation) */
	changed: any;
};

/**
 * File-based cache system with TTL (Time-To-Live) support and event emission
 *
 * Features:
 * - Persistent file-based storage that survives application restarts
 * - Automatic expiration with configurable TTL
 * - Event-driven architecture for monitoring cache operations
 * - TypeScript support with generics for type safety
 * - Automatic cleanup of expired entries
 * - Circular reference support via flatted serialization
 * - Memory-file synchronization for consistency
 *
 * @example
 * ```typescript
 * const cache = new CacheBox({ cacheDir: './my-cache' });
 *
 *
 * cache.on('error', (error) => {
 *   console.error('Cache error:', error.message);
 * });
 * ```
 */
class CacheBox extends Mitt<Events> {
	/** In-memory map storing cache keys and their TTL timestamps for fast lookup */
	private _cache = new Map<string, number>();

	/** Directory path where cache files are stored */
	private _cacheDir = ".cache";

	/** Reference to flatted parse function for deserialization with circular reference support */
	private readonly _parse = parse;

	/** Reference to flatted stringify function for serialization with circular reference support */
	private readonly _stringify = stringify;

	/**
	 * Creates a new CacheBox instance and initializes the cache system
	 *
	 * The constructor sets up the cache directory, loads existing cache files,
	 * and synchronizes the in-memory cache with the file system. Uses flatted
	 * for serialization to handle objects with circular references.
	 *
	 * @param options - Configuration options for the cache
	 * @param options.cacheDir - Custom directory for cache files (defaults to '.cache')
	 *
	 * @example
	 * ```typescript
	 * // Use default cache directory (.cache)
	 * const cache = new CacheBox();
	 *
	 * // Use custom cache directory
	 * const cache = new CacheBox({ cacheDir: './custom-cache' });
	 *
	 * // Use absolute path
	 * const cache = new CacheBox({ cacheDir: '/tmp/my-app-cache' });
	 * ```
	 */
	constructor(options?: CacheBoxOptions) {
		super();

		if (options?.cacheDir) {
			this._cacheDir = options.cacheDir;
		}

		this.load();
	}

	/**
	 * Initializes the cache system by creating directories and syncing with filesystem
	 *
	 * This method performs the initial setup:
	 * 1. Creates the cache directory if it doesn't exist
	 * 2. Calls syncMemoryCache to load existing cache files
	 * 3. Emits 'loaded' event when ready or 'error' event on failure
	 *
	 * @private
	 * @emits loaded - When cache is successfully initialized and ready to use
	 * @emits error - When initialization fails (directory creation, file access, etc.)
	 */
	private load() {
		try {
			const cacheDir = path.resolve(this._cacheDir);

			if (!existsSync(cacheDir)) {
				mkdirSync(cacheDir, {
					recursive: true,
				});
			}

			// Synchronize in-memory cache with filesystem
			this.syncMemoryCache();
		} catch (error) {
			throw error as Error;
		}
	}

	/**
	 * Checks if a specific cache file has expired and removes it if necessary
	 *
	 * Uses the FILENAME_TIME_EXTRACTOR regex to parse the filename and extract
	 * the TTL timestamp. If the current time exceeds the TTL, the file is deleted.
	 * Files with TTL of 0 never expire.
	 *
	 * @private
	 * @param file - Filename to check for expiration (format: "key_timestamp")
	 * @emits error - When file deletion fails
	 *
	 * @example
	 * Expected filename format: "user-session_1234567890"
	 * where 1234567890 is the expiration timestamp in milliseconds
	 */
	private checkExpiredFile(file: string) {
		try {
			const match = file.match(FILENAME_TIME_EXTRACTOR);
			const ttl = match ? Number(match[2]) : 0;

			// Remove file if TTL has expired (ttl = 0 means no expiration)
			if (ttl !== 0 && ttl < Date.now()) {
				rmSync(join(this._cacheDir, file));
			}
		} catch (error) {
			this.emit("error", error as Error);
		}
	}

	/**
	 * Synchronizes the in-memory cache with the filesystem
	 *
	 * This critical method ensures consistency between memory and disk:
	 * 1. Scans all files in the cache directory
	 * 2. Parses filenames to extract keys and TTL timestamps
	 * 3. Removes expired files automatically
	 * 4. Rebuilds the in-memory cache map with valid entries only
	 *
	 * This method is called during initialization and helps recover from
	 * situations where the application was restarted or crashed.
	 *
	 * @private
	 * @emits error - When file system operations fail
	 *
	 * @example
	 * If cache directory contains:
	 * - "user_0" (never expires)
	 * - "session_1234567890" (expires at timestamp)
	 * - "temp_1000000000" (already expired)
	 *
	 * Result: temp file deleted, user and session loaded into memory
	 */
	private syncMemoryCache() {
		try {
			const cacheDir = path.resolve(this._cacheDir);
			if (!existsSync(cacheDir)) return;

			const files = readdirSync(cacheDir);
			const newCache = new Map<string, number>();

			files.forEach((file) => {
				const match = file.match(FILENAME_TIME_EXTRACTOR);
				if (match) {
					const [, key, ttlStr] = match;
					const ttl = Number(ttlStr);

					// Only keep non-expired entries
					if (ttl === 0 || ttl > Date.now()) {
						newCache.set(key!, ttl);
					} else {
						// Remove expired file
						rmSync(join(cacheDir, file));
					}
				}
			});

			this._cache = newCache;
		} catch (error) {
			throw error as Error;
		}
	}

	/**
	 * Checks if a cache key exists and has not expired
	 *
	 * This method performs both existence and expiration checks:
	 * - Returns false if key doesn't exist in memory cache
	 * - Returns false if key exists but has expired (and deletes it)
	 * - Returns true only if key exists and is still valid
	 *
	 * @param key - The cache key to check
	 * @returns true if key exists and is not expired, false otherwise
	 *
	 * @example
	 * ```typescript
	 * // Check before retrieving
	 * if (cache.has('user-session')) {
	 *   const session = cache.get('user-session');
	 *   console.log('Session found:', session);
	 * } else {
	 *   console.log('Session not found or expired');
	 * }
	 *
	 * // Use in conditional logic
	 * const useCache = cache.has('expensive-calculation');
	 * const result = useCache
	 *   ? cache.get('expensive-calculation')
	 *   : performExpensiveCalculation();
	 * ```
	 */
	public has(key: string): boolean {
		if (!this._cache.has(key)) return false;

		const fileTtl = this._cache.get(key)!;
		if (fileTtl !== 0 && fileTtl < Date.now()) {
			this.delete(key);
			return false;
		}

		return true;
	}

	/**
	 * Returns the current number of entries in the in-memory cache
	 *
	 * Note: This returns the raw size of the memory cache map, which may
	 * include expired entries that haven't been cleaned up yet. For the
	 * count of valid entries, use `keys().length` instead.
	 *
	 * @returns The number of entries in the cache map
	 *
	 * @example
	 * ```typescript
	 * console.log(`Total cache entries: ${cache.size()}`);
	 * console.log(`Valid cache entries: ${cache.keys().length}`);
	 *
	 * // Monitor cache growth
	 * const initialSize = cache.size();
	 * cache.set('new-item', 'value');
	 * console.log(`Cache grew by: ${cache.size() - initialSize}`);
	 * ```
	 */
	public size(): number {
		return this._cache.size;
	}

	/**
	 * Returns an array of all valid (non-expired) cache keys
	 *
	 * This method filters the cache keys by calling `has()` on each one,
	 * which also triggers automatic cleanup of expired entries as a side effect.
	 * The returned array contains only keys for entries that currently exist
	 * and have not expired.
	 *
	 * @returns Array of valid cache keys
	 *
	 * @example
	 * ```typescript
	 * // Get all valid keys
	 * const allKeys = cache.keys();
	 * console.log('Valid cache keys:', allKeys);
	 *
	 * // Iterate over all cached items
	 * allKeys.forEach(key => {
	 *   const value = cache.get(key);
	 *   console.log(`${key}:`, value);
	 * });
	 *
	 * // Find keys matching a pattern
	 * const userKeys = cache.keys().filter(key => key.startsWith('user:'));
	 * console.log('User-related keys:', userKeys);
	 * ```
	 */
	public keys(): string[] {
		return Array.from(this._cache.keys()).filter((key) => this.has(key));
	}

	/**
	 * Returns comprehensive statistics about the current cache state
	 *
	 * Provides useful information for monitoring, debugging, and cache management:
	 * - Current number of valid entries
	 * - Cache directory path
	 * - List of all valid keys
	 *
	 * @returns Object containing cache statistics
	 * @returns returns.size - Number of valid (non-expired) cache entries
	 * @returns returns.cacheDir - Absolute or relative path to the cache directory
	 * @returns returns.keys - Array of all valid cache keys
	 *
	 * @example
	 * ```typescript
	 * // Get comprehensive cache info
	 * const stats = cache.stats();
	 * console.log('Cache Statistics:', {
	 *   entries: stats.size,
	 *   location: stats.cacheDir,
	 *   keys: stats.keys.join(', ')
	 * });
	 *
	 * // Monitor cache health
	 * if (stats.size > 1000) {
	 *   console.warn('Cache is getting large, consider cleanup');
	 * }
	 *
	 * // Debug cache contents
	 * stats.keys.forEach(key => {
	 *   console.log(`${key}: ${cache.get(key)}`);
	 * });
	 * ```
	 */
	public stats() {
		return {
			size: this.size(),
			cacheDir: this._cacheDir,
			keys: this.keys(),
		};
	}

	/**
	 * Retrieves a cached value by key with automatic type casting
	 *
	 * This method:
	 * 1. Checks if the key exists in memory cache
	 * 2. Verifies the entry hasn't expired
	 * 3. Reads the file from disk
	 * 4. Deserializes using flatted.parse (handles circular references)
	 * 5. Returns the value cast to the specified type
	 *
	 * @template T - The expected type of the cached value
	 * @param key - The cache key to retrieve
	 * @returns The cached value cast to type T, or null if not found/expired/error
	 *
	 * @emits error - When file read operations or deserialization fails
	 *
	 * @example
	 * ```typescript
	 * // Basic usage with type safety
	 * const username = cache.get<string>('username');
	 * if (username) {
	 *   console.log('Welcome back,', username);
	 * }
	 *
	 * // Complex object retrieval
	 * interface UserProfile {
	 *   id: number;
	 *   name: string;
	 *   preferences: { theme: string; language: string; };
	 * }
	 * const profile = cache.get<UserProfile>('user:123');
	 *
	 * // Handle circular references (thanks to flatted)
	 * const circularObj = cache.get<any>('circular-data');
	 *
	 * // Array retrieval
	 * const items = cache.get<string[]>('shopping-list');
	 * items?.forEach(item => console.log('- ' + item));
	 *
	 * // Fallback pattern
	 * const config = cache.get<Config>('app-config') ?? getDefaultConfig();
	 * ```
	 */
	public get<T>(key: string) {
		try {
			// Check if key exists in memory cache
			if (!this._cache.has(key)) return null;

			const fileTtl = this._cache.get(key) as number;
			const fileName = `${key}_${fileTtl}`;

			// Check if cache entry has expired
			if (fileTtl !== 0 && fileTtl < Date.now()) {
				this.checkExpiredFile(fileName);
				return null;
			}

			// Read file contents and deserialize using flatted
			const filePath = join(this._cacheDir, fileName);
			const content = readFileSync(filePath, "utf8");
			const deserialization = this._parse(content);

			return deserialization as T;
		} catch (error) {
			this.emit("error", error as Error);
			return null;
		}
	}

	/**
	 * Stores a value in the cache with optional expiration time
	 *
	 * This method:
	 * 1. Calculates the expiration timestamp based on TTL
	 * 2. Serializes the value using flatted.stringify (supports circular refs)
	 * 3. Writes the serialized data to a file with TTL in the filename
	 * 4. Updates the in-memory cache map
	 * 5. Emits a 'changed' event with the stored value
	 *
	 * @param key - The cache key under which to store the value
	 * @param value - The value to cache (any serializable type, including circular references)
	 * @param ttl - Time-to-live in milliseconds (0 = never expires, default: 0)
	 * @returns true if successful, false if failed
	 *
	 * @emits changed - When value is successfully stored (includes the stored value)
	 * @emits error - When file write operations or serialization fails
	 *
	 * @example
	 * ```typescript
	 * // Store without expiration (permanent)
	 * cache.set('app-config', { theme: 'dark', version: '2.1.0' });
	 *
	 * // Store with specific TTL
	 * cache.set('user-session', sessionData, 30 * 60 * 1000); // 30 minutes
	 * cache.set('api-response', apiData, 5 * 60 * 1000);      // 5 minutes
	 * cache.set('temp-token', token, 60 * 1000);              // 1 minute
	 *
	 * // Store complex objects with circular references
	 * const obj = { name: 'test', parent: null };
	 * obj.parent = obj; // circular reference
	 * cache.set('circular-obj', obj); // Works fine with flatted
	 *
	 * // Check operation result
	 * const success = cache.set('important-data', data);
	 * if (!success) {
	 *   console.error('Failed to cache important data');
	 *   // Handle fallback logic
	 * }
	 *
	 * // Listen for changes
	 * cache.on('changed', (value) => {
	 *   console.log('Cache updated with:', value);
	 * });
	 * ```
	 */
	public set(key: string, value: any, ttl = 0) {
		try {
			// Calculate expiration timestamp (0 = never expires)
			const fileTtl = ttl === 0 ? 0 : Date.now() + ttl;
			const fileName = `${key}_${fileTtl}`;
			const filePath = join(this._cacheDir, fileName);

			// Serialize using flatted to handle circular references
			const serialization = this._stringify(value);
			writeFileSync(filePath, serialization);

			// Update in-memory cache
			this._cache.set(key, fileTtl);

			this.emit("changed", value);
			return true;
		} catch (error) {
			this.emit("error", error as Error);
			return false;
		}
	}

	/**
	 * Removes a specific cache entry from both memory and disk
	 *
	 * This method:
	 * 1. Checks if the key exists in memory cache
	 * 2. Constructs the filename using the key and TTL
	 * 3. Uses checkExpiredFile to safely remove the file
	 * 4. Removes the entry from the in-memory cache map
	 *
	 * The method is safe to call on non-existent keys and will return true.
	 *
	 * @param key - The cache key to delete
	 * @returns true if successful or key doesn't exist, false if operation failed
	 *
	 * @emits error - When file deletion operations fail
	 *
	 * @example
	 * ```typescript
	 * // Delete specific entries
	 * cache.delete('expired-session');
	 * cache.delete('old-api-response');
	 *
	 * // Safe to call on non-existent keys
	 * const result = cache.delete('nonexistent-key'); // returns true
	 *
	 * // Delete and verify
	 * cache.set('temp-data', 'value');
	 * console.log(cache.has('temp-data')); // true
	 * cache.delete('temp-data');
	 * console.log(cache.has('temp-data')); // false
	 *
	 * // Conditional deletion
	 * if (cache.has('user-session')) {
	 *   cache.delete('user-session');
	 *   console.log('User session cleared');
	 * }
	 *
	 * // Batch deletion
	 * const keysToDelete = ['temp1', 'temp2', 'temp3'];
	 * keysToDelete.forEach(key => cache.delete(key));
	 * ```
	 */
	public delete(key: string) {
		try {
			if (!this._cache.has(key)) return true;

			const fileTtl = this._cache.get(key) as number;
			const fileName = `${key}_${fileTtl}`;

			// Remove file from disk
			this.checkExpiredFile(fileName);

			// Remove from memory cache
			this._cache.delete(key);

			return true;
		} catch (error) {
			this.emit("error", error as Error);
			return false;
		}
	}

	/**
	 * Removes all cache entries from both memory and disk
	 *
	 * This method performs a complete cache cleanup:
	 * 1. Reads all files in the cache directory
	 * 2. Deletes each file from the filesystem
	 * 3. Does NOT clear the in-memory cache (potential improvement needed)
	 *
	 * This operation is irreversible and will permanently delete all cached data.
	 *
	 * @returns null (always returns null regardless of success/failure)
	 *
	 * @emits error - When file deletion operations fail
	 *
	 * @example
	 * ```typescript
	 * // Clear all cache data
	 * cache.clear();
	 * console.log('Cache cleared');
	 *
	 * // Verify cache is empty (files deleted, but memory cache might still have entries)
	 * console.log(`Files in cache: ${cache.keys().length}`);
	 * console.log(`Memory entries: ${cache.size()}`); // May still show entries!
	 *
	 * // Listen for errors during clear operation
	 * cache.on('error', (error) => {
	 *   console.error('Failed to clear cache:', error.message);
	 * });
	 *
	 * // Clear cache before shutdown
	 * process.on('SIGTERM', () => {
	 *   cache.clear();
	 *   console.log('Cache cleared before shutdown');
	 * });
	 * ```
	 *
	 * @note This method always returns null. Monitor 'error' events to detect failures.
	 * @note BUG: This method doesn't clear the in-memory cache - consider adding this._cache.clear()
	 */
	public clear() {
		try {
			const cacheDir = path.resolve(this._cacheDir);
			const files = readdirSync(cacheDir);
			files.forEach((file) => rmSync(join(cacheDir, file)));

			this._cache.clear();

			return true;
		} catch (error) {
			this.emit("error", error as Error);
			return false;
		}
	}
}

export { CacheBox };
