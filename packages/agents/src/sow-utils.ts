import { createHash } from 'crypto';

/**
 * Normalise SOW text: lowercase, collapse whitespace.
 * Used as part of the cache key computation.
 */
export function normaliseSOW(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Hash a normalised SOW text with sha256. Returns a hex string.
 */
export function hashSOW(text: string): string {
  return createHash('sha256').update(normaliseSOW(text)).digest('hex');
}
