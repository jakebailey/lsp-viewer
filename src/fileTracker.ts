import type { TraceEntry } from './parser';

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

function applyChange(text: string, change: TextDocumentContentChangeEvent): string {
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
  startOffset += Math.min(start.character, (lines[start.line] ?? '').length);

  let endOffset = 0;
  for (let i = 0; i < end.line && i < lines.length; i++) {
    endOffset += lines[i].length + 1;
  }
  endOffset += Math.min(end.character, (lines[end.line] ?? '').length);

  return text.slice(0, startOffset) + change.text + text.slice(endOffset);
}

export function trackFiles(entries: TraceEntry[]): Map<string, TrackedFile> {
  const files = new Map<string, TrackedFile>();

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
        text = applyChange(text, change);
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
  const map: Record<string, string> = {
    'typescriptreact': 'tsx',
    'javascriptreact': 'jsx',
    'shellscript': 'bash',
    'dockercompose': 'yaml',
    'objective-c': 'objc',
    'objective-cpp': 'objc',
    'csharp': 'c#',
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
