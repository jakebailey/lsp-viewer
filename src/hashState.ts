import { compressToEncodedURIComponent, decompressFromEncodedURIComponent } from 'lz-string';

const HASH_PREFIX = '#v1=';

// Conservative limit for copy-paste sharing (Chrome address bar)
export const URL_MAX_LENGTH = 2_000_000;

export interface HashSizeInfo {
  compressedLength: number;
  maxLength: number;
  ratio: number;
  tooLarge: boolean;
  stored: boolean;
}

export function writeTraceToHash(trace: string): HashSizeInfo {
  const compressed = HASH_PREFIX + compressToEncodedURIComponent(trace);
  const compressedLength = compressed.length;
  const ratio = compressedLength / URL_MAX_LENGTH;
  const tooLarge = compressedLength > URL_MAX_LENGTH;

  if (tooLarge) {
    history.replaceState(null, '', location.pathname);
    return { compressedLength, maxLength: URL_MAX_LENGTH, ratio, tooLarge, stored: false };
  }
  history.replaceState(null, '', compressed);
  return { compressedLength, maxLength: URL_MAX_LENGTH, ratio, tooLarge, stored: true };
}

export function readTraceFromHash(): string | null {
  const hash = location.hash;
  if (!hash) return null;

  try {
    if (hash.startsWith(HASH_PREFIX)) {
      const data = hash.slice(HASH_PREFIX.length);
      const result = decompressFromEncodedURIComponent(data);
      return result || null;
    }
  } catch {
    // ignore corrupt hashes
  }

  return null;
}

export function clearHash(): void {
  history.replaceState(null, '', location.pathname);
}
