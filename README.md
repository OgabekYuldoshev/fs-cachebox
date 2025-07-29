# CacheBox

A fast, feature-rich file-based cache system for Node.js with compression, TTL, and event support.

## Features

- 🚀 **Fast**: Both sync and async operations
- 💾 **Persistent**: File-based storage survives restarts  
- 🗜️ **Compression**: Optional gzip compression for large values
- ⏰ **TTL Support**: Automatic expiration of cache entries
- 🧹 **Auto Cleanup**: Removes expired entries automatically
- 📊 **Statistics**: Built-in performance monitoring
- 🔒 **Safe**: Key validation and error handling
- 📦 **Batch Operations**: Set/get multiple entries at once

## Installation

```bash
npm install fs-cachebox
```

## Quick Start

```typescript
import { CacheBox } from 'fs-cachebox';

// Create cache instance
const cache = new CacheBox({
  cacheDir: './my-cache',
  enableCompression: true,
  defaultTTL: 60000 // 1 minute
});

// Store data
cache.set('user:123', { name: 'John', age: 30 });

// Retrieve data
const user = cache.get('user:123');
console.log(user); // { name: 'John', age: 30 }

// Check if key exists
if (cache.has('user:123')) {
  console.log('User found!');
}

// Set with custom TTL (5 seconds)
cache.set('temp-data', 'expires soon', 5000);

// Delete entry
cache.delete('user:123');
```

## Configuration Options

```typescript
const cache = new CacheBox({
  cacheDir: '.cache',              // Cache directory
  enableCompression: false,        // Enable gzip compression
  compressionThreshold: 1024,      // Min size for compression (bytes)
  compressionLevel: 6,             // Compression level (1-9)
  maxSize: 1000,                   // Max cache entries
  maxFileSize: 50 * 1024 * 1024,   // Max file size (50MB)
  defaultTTL: 0,                   // Default TTL (0 = no expiration)
  cleanupInterval: 300000,         // Cleanup interval (5 minutes)
  enableAutoCleanup: true,         // Auto cleanup expired entries
  enableLogging: false             // Enable debug logging
});
```

## Async Operations

```typescript
// Async operations for better performance
const user = await cache.getAsync('user:123');
await cache.setAsync('user:456', userData, 30000);
await cache.deleteAsync('user:123');

// Batch operations
await cache.setManyAsync([
  { key: 'user:1', value: userData1 },
  { key: 'user:2', value: userData2, ttl: 60000 }
]);

const results = await cache.getManyAsync(['user:1', 'user:2']);
```

## Events

```typescript
cache.on('ready', ({ entriesLoaded, cacheDir }) => {
  console.log(`Cache ready with ${entriesLoaded} entries`);
});

cache.on('change', ({ operation, key }) => {
  console.log(`${operation} performed on ${key}`);
});

cache.on('expire', ({ key, ttl }) => {
  console.log(`Key ${key} expired`);
});

cache.on('error', (error) => {
  console.error('Cache error:', error);
});
```

## Statistics & Monitoring

```typescript
// Get performance stats
const stats = cache.stats();
console.log(`Hit rate: ${(stats.performance.hitRate * 100).toFixed(2)}%`);
console.log(`Total entries: ${stats.entries}`);
console.log(`Cache size: ${stats.totalSize} bytes`);

// Manual cleanup
const { expired, removed } = cache.cleanup();
console.log(`Cleaned up ${expired} expired, ${removed} evicted entries`);

// Get all keys
const keys = cache.keys();
console.log('Cached keys:', keys);
```

## Error Handling

```typescript
try {
  const result = cache.get('some-key');
  if (result === null) {
    console.log('Key not found or expired');
  }
} catch (error) {
  if (error instanceof CacheError) {
    console.error(`Cache operation failed: ${error.operation}`);
  }
}

// Listen for errors
cache.on('error', (error) => {
  console.error('Cache error:', error.message);
});
```

## Best Practices

- Use compression for large objects (>1KB)
- Set appropriate TTL values to prevent memory bloat
- Monitor cache hit rates with `cache.stats()`
- Use async methods for better performance in I/O heavy applications
- Handle cache misses gracefully in your application logic

## License

ISC

## Contributing

Pull requests are welcome! Please ensure tests pass and follow the existing code style.