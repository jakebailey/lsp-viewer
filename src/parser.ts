export type Direction = 'sent' | 'received';
export type MessageType = 'request' | 'response' | 'notification';

export interface TraceEntry {
  id: number;
  timestamp: string;
  direction: Direction;
  messageType: MessageType;
  method: string;
  requestId?: string;
  latencyMs?: number;
  latencyRaw?: string;
  body: unknown | undefined;
  bodyRaw: string;
  bodyLabel: 'Params' | 'Result' | 'Error' | 'No result';
  raw: string;
  sessionIndex: number;
}

// New format: "2026-03-27 21:18:04.090 [trace] Sending request 'method' in 3ms."
const NEW_HEADER = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}) \[trace\] (Sending|Received) (notification|request|response) '([^']+)'(?: in (\d+(?:\.\d+)?)(ms|µs|s))?\.?\s*$/;

// Old format: "[Trace - 9:31:59 PM] Sending response 'method'. Processing request took 1ms"
const OLD_HEADER = /^\[Trace\s*-\s*([^\]]+)\]\s*(Sending|Received)\s+(notification|request|response)\s+'([^']+)'\.(?:\s*Processing request took (\d+(?:\.\d+)?)(ms|µs|s))?\s*$/;

const METHOD_ID = /^(.+?) - \(([^)]+)\)$/;

interface ParsedHeader {
  timestamp: string;
  direction: string;
  messageType: string;
  rawMethod: string;
  latencyNum?: string;
  latencyUnit?: string;
}

function matchHeader(line: string): ParsedHeader | null {
  let m = line.match(NEW_HEADER);
  if (m) {
    return { timestamp: m[1], direction: m[2], messageType: m[3], rawMethod: m[4], latencyNum: m[5], latencyUnit: m[6] };
  }
  m = line.match(OLD_HEADER);
  if (m) {
    return { timestamp: m[1].trim(), direction: m[2], messageType: m[3], rawMethod: m[4], latencyNum: m[5], latencyUnit: m[6] };
  }
  return null;
}

export function parseTrace(text: string): TraceEntry[] {
  const lines = text.split('\n');
  const entries: TraceEntry[] = [];
  let sessionIndex = 0;
  let current: {
    header: ParsedHeader;
    bodyLines: string[];
    rawLines: string[];
    startIndex: number;
  } | null = null;

  function flushEntry() {
    if (!current) return;
    const { timestamp, direction: dirStr, messageType: msgType, rawMethod, latencyNum, latencyUnit } = current.header;
    const direction: Direction = dirStr === 'Sending' ? 'sent' : 'received';
    const messageType = msgType as MessageType;

    let method = rawMethod;
    let requestId: string | undefined;
    const idMatch = rawMethod.match(METHOD_ID);
    if (idMatch) {
      method = idMatch[1];
      requestId = idMatch[2];
    }

    let latencyMs: number | undefined;
    let latencyRaw: string | undefined;
    if (latencyNum !== undefined) {
      const num = parseFloat(latencyNum);
      latencyRaw = `${latencyNum}${latencyUnit}`;
      if (latencyUnit === 'ms') latencyMs = num;
      else if (latencyUnit === 'µs') latencyMs = num / 1000;
      else if (latencyUnit === 's') latencyMs = num * 1000;
    }

    const bodyText = current.bodyLines.join('\n').trim();
    let bodyLabel: TraceEntry['bodyLabel'] = 'Params';
    let bodyContent = bodyText;

    if (bodyContent.startsWith('Params:')) {
      bodyLabel = 'Params';
      bodyContent = bodyContent.slice('Params:'.length).trim();
    } else if (bodyContent.startsWith('Result:')) {
      bodyLabel = 'Result';
      bodyContent = bodyContent.slice('Result:'.length).trim();
    } else if (bodyContent.startsWith('Error:')) {
      bodyLabel = 'Error';
      bodyContent = bodyContent.slice('Error:'.length).trim();
    } else if (bodyContent.startsWith('No result returned.')) {
      bodyLabel = 'No result';
      bodyContent = '';
    }

    let body: unknown | undefined;
    if (bodyContent) {
      try {
        body = JSON.parse(bodyContent);
      } catch {
        body = bodyContent;
      }
    }

    entries.push({
      id: entries.length,
      timestamp,
      direction,
      messageType,
      method,
      requestId,
      latencyMs,
      latencyRaw,
      body,
      bodyRaw: bodyContent,
      bodyLabel,
      raw: current.rawLines.join('\n'),
      sessionIndex,
    });
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const header = matchHeader(line);
    if (header) {
      // Detect session boundary: a sent initialize request starts a new session
      const methodId = header.rawMethod.match(METHOD_ID);
      const method = methodId ? methodId[1] : header.rawMethod;
      if (method === 'initialize' && header.direction === 'Sending' && header.messageType === 'request') {
        // Flush previous entry first so it gets the old session index
        flushEntry();
        sessionIndex++;
        current = { header, bodyLines: [], rawLines: [line], startIndex: i };
      } else {
        flushEntry();
        current = { header, bodyLines: [], rawLines: [line], startIndex: i };
      }
    } else if (current) {
      current.bodyLines.push(line);
      current.rawLines.push(line);
    }
  }
  flushEntry();

  return entries;
}

export function matchRequestResponse(entries: TraceEntry[]): Map<string, { request?: TraceEntry; response?: TraceEntry }> {
  const pairs = new Map<string, { request?: TraceEntry; response?: TraceEntry }>();
  for (const entry of entries) {
    if (entry.requestId === undefined) continue;
    if (entry.messageType === 'request' || entry.messageType === 'response') {
      const existing = pairs.get(entry.requestId) ?? {};
      if (entry.messageType === 'request') existing.request = entry;
      else existing.response = entry;
      pairs.set(entry.requestId, existing);
    }
  }
  return pairs;
}

/** Build a map from cancelled request ID to the $/cancelRequest entry that cancelled it */
export function getCancellations(entries: TraceEntry[]): Map<string, TraceEntry> {
  const cancellations = new Map<string, TraceEntry>();
  for (const entry of entries) {
    if (entry.method === '$/cancelRequest' && entry.body && typeof entry.body === 'object') {
      const id = (entry.body as { id?: string | number }).id;
      if (id !== undefined) {
        cancellations.set(String(id), entry);
      }
    }
  }
  return cancellations;
}

/** For a $/cancelRequest entry, get the request ID it's cancelling */
export function getCancelledRequestId(entry: TraceEntry): string | undefined {
  if (entry.method !== '$/cancelRequest' || !entry.body || typeof entry.body !== 'object') return undefined;
  const id = (entry.body as { id?: string | number }).id;
  return id !== undefined ? String(id) : undefined;
}

// Methods that are logging/trace infrastructure, not real LSP traffic
export const LOG_METHODS = new Set([
  'window/logMessage',
  '$/setTrace',
  '$/logTrace',
  'telemetry/event',
]);

export interface SessionInfo {
  index: number;
  firstEntry: TraceEntry;
  lastEntry: TraceEntry;
  count: number;
}

export function getSessions(entries: TraceEntry[]): SessionInfo[] {
  const map = new Map<number, { first: TraceEntry; last: TraceEntry; count: number }>();
  for (const entry of entries) {
    const existing = map.get(entry.sessionIndex);
    if (!existing) {
      map.set(entry.sessionIndex, { first: entry, last: entry, count: 1 });
    } else {
      existing.last = entry;
      existing.count++;
    }
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, { first, last, count }]) => ({ index, firstEntry: first, lastEntry: last, count }));
}

export function getMethodCategory(method: string): string {
  const slash = method.indexOf('/');
  return slash >= 0 ? method.slice(0, slash) : method;
}
