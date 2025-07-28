import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { CacheBox } from '../src/main';

describe('CacheBox Essential Tests', () => {
  const testCacheDir = './test-cache';
  let cache: CacheBox;

  beforeEach(async () => {
    // Clean up any existing test cache
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true});
    }
    
    // Create fresh cache instance
    cache = new CacheBox({ cacheDir: testCacheDir });
    
  });

  afterEach(() => {
    // Clean up after each test
    if (existsSync(testCacheDir)) {
      rmSync(testCacheDir, { recursive: true, force: true });
    }
  });

  // Basic functionality tests
  it('should set and get string values', () => {
    cache.set('test-string', 'hello world');
    const result = cache.get<string>('test-string');
    expect(result).toBe('hello world');
  });

  it('should set and get object values', () => {
    const testObj = { name: 'John', age: 30 };
    cache.set('test-obj', testObj);
    const result = cache.get<typeof testObj>('test-obj');
    expect(result).toEqual(testObj);
  });

  it('should return null for non-existent keys', () => {
    const result = cache.get('does-not-exist');
    expect(result).toBeNull();
  });

  // TTL tests
  it('should handle TTL expiration', async () => {
    cache.set('expire-test', 'value', 50); // 50ms TTL
    
    // Should exist immediately
    expect(cache.get('expire-test')).toBe('value');
    
    // Wait for expiration
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Should be null after expiration
    expect(cache.get('expire-test')).toBeNull();
  });

  it('should store permanent values with TTL 0', () => {
    cache.set('permanent', 'forever', 0);
    expect(cache.get('permanent')).toBe('forever');
  });

  // Utility methods tests
  it('should check key existence with has()', () => {
    cache.set('exists', 'value');
    expect(cache.has('exists')).toBe(true);
    expect(cache.has('not-exists')).toBe(false);
  });

  it('should return correct size', () => {
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    expect(cache.size()).toBe(2);
  });

  it('should return all keys', () => {
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    const keys = cache.keys();
    expect(keys).toContain('key1');
    expect(keys).toContain('key2');
    expect(keys.length).toBe(2);
  });

  it('should return cache stats', () => {
    cache.set('test', 'value');
    const stats = cache.stats();
    expect(stats).toHaveProperty('size');
    expect(stats).toHaveProperty('cacheDir');
    expect(stats).toHaveProperty('keys');
    expect(stats.size).toBe(1);
    expect(stats.keys).toContain('test');
  });

  // Delete operations
  it('should delete existing keys', () => {
    cache.set('delete-me', 'value');
    expect(cache.has('delete-me')).toBe(true);
    
    const success = cache.delete('delete-me');
    expect(success).toBe(true);
    expect(cache.has('delete-me')).toBe(false);
  });

  it('should handle deleting non-existent keys', () => {
    const success = cache.delete('does-not-exist');
    expect(success).toBe(true);
  });

  // Clear operations
  it('should clear all cache', () => {
    cache.set('key1', 'value1');
    cache.set('key2', 'value2');
    expect(cache.size()).toBe(2);
    
    cache.clear();
    expect(cache.keys().length).toBe(0);
  });

  // Persistence test
  it('should persist data across instances', async () => {
    // Set data in first instance
    cache.set('persist', 'persistent-value');
    
    // Create new instance with same directory
    const newCache = new CacheBox({ cacheDir: testCacheDir });
    
    // Should find the persisted data
    expect(newCache.get('persist')).toBe('persistent-value');
  });

  // Event system
  it('should emit changed event on set', () => {
    cache.on('changed', (value) => {
      expect(value).toBe('test-value');
    });
    
    cache.set('test', 'test-value');
  });

  // Data types
  it('should handle different data types', () => {
    // Number
    cache.set('number', 42);
    expect(cache.get<number>('number')).toBe(42);
    
    // Boolean
    cache.set('boolean', true);
    expect(cache.get<boolean>('boolean')).toBe(true);
    
    // Array
    cache.set('array', [1, 2, 3]);
    expect(cache.get<number[]>('array')).toEqual([1, 2, 3]);
    
    // Null
    cache.set('null', null);
    expect(cache.get('null')).toBeNull();
  });
});