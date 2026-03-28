import type { TraceEntry } from './parser';

export type PositionEncoding = 'utf-8' | 'utf-16' | 'utf-32';

export interface FileSnapshot {
  uri: string;
  languageId: string;
  version: number;
  text: string;
  entryId: number;
  timestamp: string;
}

export interface TrackedFile {
  uri: string;
  languageId: string;
  snapshots: FileSnapshot[];
  closed: boolean;
}

interface DidOpenParams {
  textDocument: {
    uri: string;
    languageId: string;
    version: number;
    text: string;
  };
}

interface Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

interface TextDocumentContentChangeEvent {
  range?: Range;
  rangeLength?: number;
  text: string;
}

interface DidChangeParams {
  textDocument: {
    uri: string;
    version: number;
  };
  contentChanges: TextDocumentContentChangeEvent[];
}

interface DidCloseParams {
  textDocument: {
    uri: string;
  };
}

/**
 * Convert a character offset in the given encoding to a JS string index (UTF-16 code units).
 * 
 * - utf-16: character is already a UTF-16 code unit offset (JS native), use directly
 * - utf-32: character counts Unicode code points; iterate code points to find the JS index
 * - utf-8: character counts UTF-8 bytes; encode each code point to count bytes
 */
function charOffsetToStringIndex(line: string, character: number, encoding: PositionEncoding): number {
  if (encoding === 'utf-16') {
    // JS strings are UTF-16, so character offset maps directly to string index
    return Math.min(character, line.length);
  }

  if (encoding === 'utf-32') {
    // Count Unicode code points
    let jsIndex = 0;
    let cpCount = 0;
    while (jsIndex < line.length && cpCount < character) {
      const cp = line.codePointAt(jsIndex)!;
      jsIndex += cp > 0xFFFF ? 2 : 1; // Surrogate pair takes 2 UTF-16 code units
      cpCount++;
    }
    return jsIndex;
  }

  // utf-8: count UTF-8 bytes
  let jsIndex = 0;
  let byteCount = 0;
  while (jsIndex < line.length && byteCount < character) {
    const cp = line.codePointAt(jsIndex)!;
    // Calculate UTF-8 byte length of this code point
    if (cp <= 0x7F) byteCount += 1;
    else if (cp <= 0x7FF) byteCount += 2;
    else if (cp <= 0xFFFF) byteCount += 3;
    else byteCount += 4;

    jsIndex += cp > 0xFFFF ? 2 : 1;
  }
  return jsIndex;
}

function applyChange(text: string, change: TextDocumentContentChangeEvent, encoding: PositionEncoding): string {
  // Full replacement (no range specified)
  if (!change.range) {
    return change.text;
  }

  const lines = text.split('\n');
  const { start, end } = change.range;

  // Convert position to offset
  let startOffset = 0;
  for (let i = 0; i < start.line && i < lines.length; i++) {
    startOffset += lines[i].length + 1; // +1 for \n
  }
  const startLine = lines[start.line] ?? '';
  startOffset += charOffsetToStringIndex(startLine, start.character, encoding);

  let endOffset = 0;
  for (let i = 0; i < end.line && i < lines.length; i++) {
    endOffset += lines[i].length + 1;
  }
  const endLine = lines[end.line] ?? '';
  endOffset += charOffsetToStringIndex(endLine, end.character, encoding);

  return text.slice(0, startOffset) + change.text + text.slice(endOffset);
}

export function trackFiles(entries: TraceEntry[]): Map<string, TrackedFile> {
  const files = new Map<string, TrackedFile>();

  // Detect position encoding from initialize response.
  // Default is utf-16 per the LSP spec.
  let encoding: PositionEncoding = 'utf-16';
  for (const entry of entries) {
    if (entry.method === 'initialize' && entry.messageType === 'response' && entry.direction === 'received') {
      const result = entry.body as { capabilities?: { positionEncoding?: string } } | null;
      const enc = result?.capabilities?.positionEncoding;
      if (enc === 'utf-8' || enc === 'utf-16' || enc === 'utf-32') {
        encoding = enc;
      }
      break; // Use the first initialize response
    }
  }

  for (const entry of entries) {
    if (entry.direction !== 'sent') continue;
    if (entry.messageType !== 'notification') continue;
    if (!entry.body || typeof entry.body !== 'object') continue;

    if (entry.method === 'textDocument/didOpen') {
      const params = entry.body as DidOpenParams;
      const doc = params.textDocument;
      if (!doc?.uri || typeof doc.text !== 'string') continue;

      const snapshot: FileSnapshot = {
        uri: doc.uri,
        languageId: doc.languageId ?? 'plaintext',
        version: doc.version ?? 0,
        text: doc.text,
        entryId: entry.id,
        timestamp: entry.timestamp,
      };

      const tracked = files.get(doc.uri);
      if (tracked) {
        // Re-opened
        tracked.languageId = snapshot.languageId;
        tracked.snapshots.push(snapshot);
        tracked.closed = false;
      } else {
        files.set(doc.uri, {
          uri: doc.uri,
          languageId: snapshot.languageId,
          snapshots: [snapshot],
          closed: false,
        });
      }
    } else if (entry.method === 'textDocument/didChange') {
      const params = entry.body as DidChangeParams;
      const doc = params.textDocument;
      if (!doc?.uri || !params.contentChanges) continue;

      const tracked = files.get(doc.uri);
      if (!tracked || tracked.snapshots.length === 0) continue;

      const lastSnapshot = tracked.snapshots[tracked.snapshots.length - 1];
      let text = lastSnapshot.text;

      // Apply changes in order
      for (const change of params.contentChanges) {
        text = applyChange(text, change, encoding);
      }

      tracked.snapshots.push({
        uri: doc.uri,
        languageId: tracked.languageId,
        version: doc.version ?? lastSnapshot.version + 1,
        text,
        entryId: entry.id,
        timestamp: entry.timestamp,
      });
    } else if (entry.method === 'textDocument/didClose') {
      const params = entry.body as DidCloseParams;
      const doc = params.textDocument;
      if (!doc?.uri) continue;

      const tracked = files.get(doc.uri);
      if (tracked) {
        tracked.closed = true;
      }
    }
  }

  return files;
}

/** Map LSP languageId to a shiki language identifier */
export function lspLangToShiki(languageId: string): string {
  // Most VS Code / LSP language IDs match shiki's bundled language names directly.
  // This map handles the ones that don't.
  const map: Record<string, string> = {
    'typescriptreact': 'tsx',
    'javascriptreact': 'jsx',
    'dockercompose': 'yaml',
    'git-commit': 'text',
    'git-rebase': 'text',
    'pip-requirements': 'text',
    'plaintext': 'text',
    'raw': 'text',
    'scminput': 'text',
    'search-result': 'text',
    'jsonc': 'json',
    'jade': 'pug',
    'postcss': 'css',
    'stylus': 'css',
  };
  return map[languageId] ?? languageId;
}

/** Get just the filename from a URI */
export function uriToFilename(uri: string): string {
  try {
    const path = new URL(uri).pathname;
    return path.split('/').pop() ?? uri;
  } catch {
    return uri.split('/').pop() ?? uri;
  }
}

/** Get a short relative path from a URI */
export function uriToShortPath(uri: string): string {
  try {
    const path = new URL(uri).pathname;
    const parts = path.split('/');
    if (parts.length > 3) {
      return '.../' + parts.slice(-3).join('/');
    }
    return path;
  } catch {
    return uri;
  }
}
