// @file: tools/src/core/lazySchema.ts
// Deferred Zod schema construction to avoid circular import issues at module load time.

/**
 * Returns a memoized factory that constructs the value on first call.
 * Used to defer Zod schema evaluation from module init time to first access.
 */
export function lazySchema<T>(factory: () => T): () => T {
  let cached: T | undefined;
  return () => (cached ??= factory());
}
