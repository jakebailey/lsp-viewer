/**
 * Smart JSON formatter that inlines small values and only expands large ones.
 * Produces much more compact output than JSON.stringify(v, null, 2) for
 * deeply nested LSP messages with lots of small arrays/objects.
 */
export function formatJson(value: unknown, maxWidth = 120): string {
  return formatValue(value, 0, maxWidth);
}

function formatValue(value: unknown, indent: number, maxWidth: number): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'number':
    case 'boolean':
      return String(value);
  }

  if (Array.isArray(value)) {
    return formatArray(value, indent, maxWidth);
  }

  if (typeof value === 'object') {
    return formatObject(value as Record<string, unknown>, indent, maxWidth);
  }

  return String(value);
}

function formatArray(arr: unknown[], indent: number, maxWidth: number): string {
  if (arr.length === 0) return '[]';

  // Try inline first
  const inline = tryInlineArray(arr);
  if (inline !== null && indent + inline.length <= maxWidth) {
    return inline;
  }

  // Expanded
  const pad = '  '.repeat(indent + 1);
  const closePad = '  '.repeat(indent);
  const items = arr.map(item => pad + formatValue(item, indent + 1, maxWidth));
  return '[\n' + items.join(',\n') + '\n' + closePad + ']';
}

function formatObject(obj: Record<string, unknown>, indent: number, maxWidth: number): string {
  const keys = Object.keys(obj);
  if (keys.length === 0) return '{}';

  // Try inline first
  const inline = tryInlineObject(obj);
  if (inline !== null && indent + inline.length <= maxWidth) {
    return inline;
  }

  // Expanded
  const pad = '  '.repeat(indent + 1);
  const closePad = '  '.repeat(indent);
  const entries = keys.map(key => {
    const val = formatValue(obj[key], indent + 1, maxWidth);
    return pad + JSON.stringify(key) + ': ' + val;
  });
  return '{\n' + entries.join(',\n') + '\n' + closePad + '}';
}

/** Try to produce a single-line representation. Returns null if too complex or too long. */
function tryInlineArray(arr: unknown[]): string | null {
  const parts: string[] = [];
  let len = 2; // [ ]
  for (const item of arr) {
    const s = tryInlineValue(item);
    if (s === null) return null;
    parts.push(s);
    len += s.length + 2; // ", "
    if (len > 100) return null; // bail early if clearly too long
  }
  return '[' + parts.join(', ') + ']';
}

function tryInlineObject(obj: Record<string, unknown>): string | null {
  const keys = Object.keys(obj);
  const parts: string[] = [];
  let len = 4; // { }
  for (const key of keys) {
    const val = tryInlineValue(obj[key]);
    if (val === null) return null;
    const entry = JSON.stringify(key) + ': ' + val;
    parts.push(entry);
    len += entry.length + 2;
    if (len > 100) return null;
  }
  return '{ ' + parts.join(', ') + ' }';
}

function tryInlineValue(value: unknown): string | null {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';

  switch (typeof value) {
    case 'string': {
      const s = JSON.stringify(value);
      return s.length <= 80 ? s : null;
    }
    case 'number':
    case 'boolean':
      return String(value);
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return tryInlineArray(value);
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return '{}';
    return tryInlineObject(obj);
  }

  return null;
}
