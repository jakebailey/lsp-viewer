import { createSignal, createMemo, For, Show, type Component, onMount } from 'solid-js';
import { parseTrace, matchRequestResponse, getSessions, getMethodCategory, LOG_METHODS, type TraceEntry, type Direction, type MessageType } from './parser';
import TraceEntryRow, { createExpandedSet } from './TraceEntryRow';
import { readTraceFromHash, writeTraceToHash, clearHash, type HashSizeInfo } from './hashState';
import './App.css';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

const UrlSizeIndicator: Component<{ info: HashSizeInfo }> = (props) => {
  const pct = () => Math.min(props.info.ratio * 100, 100);
  const color = () => {
    const r = props.info.ratio;
    if (r > 1) return 'var(--error-color)';
    if (r > 0.75) return 'var(--not-color)';
    if (r > 0.5) return 'var(--accent)';
    return 'var(--received-color)';
  };
  const tooltip = () => {
    const { compressedLength, maxLength, tooLarge, stored } = props.info;
    const lines = [
      `Compressed: ${formatBytes(compressedLength)}`,
      `Limit: ${formatBytes(maxLength)} (~2 MB)`,
      `Usage: ${pct().toFixed(1)}%`,
    ];
    if (tooLarge) lines.push('⚠ Too large for URL — not stored');
    else if (stored) lines.push('✓ Stored in URL — shareable');
    return lines.join('\n');
  };

  // SVG pie chart
  const r = 10;
  const circumference = 2 * Math.PI * r;
  const dashLen = () => circumference * Math.min(props.info.ratio, 1);

  return (
    <span class="url-size-indicator" title={tooltip()}>
      <svg width="24" height="24" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r={r} fill="none" stroke="var(--border)" stroke-width="3" />
        <circle
          cx="12" cy="12" r={r}
          fill="none"
          stroke={color()}
          stroke-width="3"
          stroke-dasharray={`${dashLen()} ${circumference}`}
          stroke-dashoffset={circumference * 0.25}
          stroke-linecap="round"
        />
      </svg>
      <Show when={props.info.tooLarge}>
        <span class="url-size-warning">!</span>
      </Show>
    </span>
  );
};

const App: Component = () => {
  const [rawText, setRawText] = createSignal('');
  const [entries, setEntries] = createSignal<TraceEntry[]>([]);
  const [filterMethod, setFilterMethod] = createSignal('');
  const [filterDirection, setFilterDirection] = createSignal<Direction | ''>('');
  const [filterType, setFilterType] = createSignal<MessageType | ''>('');
  const [searchText, setSearchText] = createSignal('');
  const [hideLogging, setHideLogging] = createSignal(true);
  const [filterSession, setFilterSession] = createSignal<number | ''>('');
  const [showImport, setShowImport] = createSignal(true);
  const [isLight, setIsLight] = createSignal(false);
  const [hashSize, setHashSize] = createSignal<HashSizeInfo | null>(null);

  function toggleTheme() {
    const next = !isLight();
    setIsLight(next);
    document.documentElement.classList.toggle('light', next);
  }

  const { expandedIds, toggle, expandAll, collapseAll } = createExpandedSet();

  // Restore from URL hash on mount
  onMount(() => {
    const saved = readTraceFromHash();
    if (saved) {
      setRawText(saved);
      const parsed = parseTrace(saved);
      setEntries(parsed);
      if (parsed.length > 0) {
        setShowImport(false);
        setHashSize(writeTraceToHash(saved));
      }
    }
  });

  const entryRefs: Record<number, HTMLDivElement> = {};

  const pairs = createMemo(() => matchRequestResponse(entries()));

  const sessions = createMemo(() => getSessions(entries()));

  const methods = createMemo(() => {
    const set = new Set<string>();
    for (const e of entries()) set.add(e.method);
    return [...set].sort();
  });

  // Group methods by category for the dropdown
  const methodsByCategory = createMemo(() => {
    const cats = new Map<string, string[]>();
    for (const m of methods()) {
      const cat = getMethodCategory(m);
      if (!cats.has(cat)) cats.set(cat, []);
      cats.get(cat)!.push(m);
    }
    return [...cats.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });

  const filtered = createMemo(() => {
    let result = entries();
    const method = filterMethod();
    const dir = filterDirection();
    const type = filterType();
    const search = searchText().toLowerCase();
    const session = filterSession();
    const noise = hideLogging();

    if (noise) result = result.filter(e => !LOG_METHODS.has(e.method));
    if (session !== '') result = result.filter(e => e.sessionIndex === session);
    if (method) {
      // Support filtering by category prefix (e.g. "textDocument/*")
      if (method.endsWith('/*')) {
        const prefix = method.slice(0, -2);
        result = result.filter(e => getMethodCategory(e.method) === prefix);
      } else {
        result = result.filter(e => e.method === method);
      }
    }
    if (dir) result = result.filter(e => e.direction === dir);
    if (type) result = result.filter(e => e.messageType === type);
    if (search) {
      result = result.filter(e =>
        e.method.toLowerCase().includes(search) ||
        e.bodyRaw.toLowerCase().includes(search) ||
        e.timestamp.includes(search)
      );
    }
    return result;
  });

  const stats = createMemo(() => {
    const all = entries();
    const requests = all.filter(e => e.messageType === 'request').length;
    const responses = all.filter(e => e.messageType === 'response').length;
    const notifications = all.filter(e => e.messageType === 'notification').length;
    const sent = all.filter(e => e.direction === 'sent').length;
    const received = all.filter(e => e.direction === 'received').length;
    return { total: all.length, requests, responses, notifications, sent, received };
  });

  function handleParse() {
    const text = rawText();
    const parsed = parseTrace(text);
    setEntries(parsed);
    if (parsed.length > 0) {
      setShowImport(false);
      setHashSize(writeTraceToHash(text));
    }
    collapseAll();
  }

  function handleClear() {
    setRawText('');
    setEntries([]);
    setShowImport(true);
    setFilterMethod('');
    setFilterDirection('');
    setFilterType('');
    setSearchText('');
    setFilterSession('');
    setHideLogging(true);
    collapseAll();
    clearHash();
    setHashSize(null);
  }

  function scrollToEntry(id: number) {
    const el = entryRefs[id];
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-flash');
      setTimeout(() => el.classList.remove('highlight-flash'), 1200);
    }
  }

  function getPairedEntry(entry: TraceEntry): TraceEntry | undefined {
    if (entry.requestId === undefined) return undefined;
    const pair = pairs().get(entry.requestId);
    if (!pair) return undefined;
    if (entry.messageType === 'request') return pair.response;
    if (entry.messageType === 'response') return pair.request;
    return undefined;
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault();
    const file = e.dataTransfer?.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        setRawText(text);
        const parsed = parseTrace(text);
        setEntries(parsed);
        if (parsed.length > 0) {
          setShowImport(false);
          setHashSize(writeTraceToHash(text));
        }
        collapseAll();
      };
      reader.readAsText(file);
    }
  }

  function handleFileInput(e: Event) {
    const target = e.target as HTMLInputElement;
    const file = target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        setRawText(text);
        const parsed = parseTrace(text);
        setEntries(parsed);
        if (parsed.length > 0) {
          setShowImport(false);
          setHashSize(writeTraceToHash(text));
        }
        collapseAll();
      };
      reader.readAsText(file);
    }
  }

  return (
    <div class="app">
      <header class="app-header">
        <h1>LSP Trace Viewer</h1>
        <div class="header-actions">
          <Show when={hashSize()}>
            {(info) => <UrlSizeIndicator info={info()} />}
          </Show>
          <Show when={!showImport()}>
            <button class="btn btn-secondary" onClick={() => { setShowImport(true); clearHash(); setHashSize(null); }}>Import New</button>
            <button class="btn btn-secondary" onClick={handleClear}>Clear</button>
          </Show>
          <button class="btn btn-secondary theme-toggle" onClick={toggleTheme} title={isLight() ? 'Switch to dark mode' : 'Switch to light mode'}>
            {isLight() ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      <Show when={showImport()}>
        <section
          class="import-section"
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
        >
          <textarea
            class="trace-input"
            placeholder="Paste LSP trace output here, or drag & drop a log file..."
            value={rawText()}
            onInput={(e) => setRawText(e.currentTarget.value)}
          />
          <div class="import-actions">
            <button class="btn btn-primary" onClick={handleParse} disabled={!rawText()}>
              Parse Trace
            </button>
            <label class="btn btn-secondary file-btn">
              Load File
              <input type="file" accept=".log,.txt,.json" onChange={handleFileInput} hidden />
            </label>
            <Show when={entries().length > 0}>
              <button class="btn btn-secondary" onClick={() => setShowImport(false)}>
                Back to Viewer
              </button>
            </Show>
          </div>
        </section>
      </Show>

      <Show when={entries().length > 0 && !showImport()}>
        <section class="stats-bar">
          <span class="stat">{stats().total} messages</span>
          <span class="stat stat-sent">↑ {stats().sent} sent</span>
          <span class="stat stat-received">↓ {stats().received} received</span>
          <span class="stat stat-req">{stats().requests} requests</span>
          <span class="stat stat-res">{stats().responses} responses</span>
          <span class="stat stat-not">{stats().notifications} notifications</span>
        </section>

        <section class="filters">
          <input
            type="text"
            class="filter-search"
            placeholder="Search methods, payloads..."
            value={searchText()}
            onInput={(e) => setSearchText(e.currentTarget.value)}
          />
          <select
            class="filter-select"
            value={filterMethod()}
            onChange={(e) => setFilterMethod(e.currentTarget.value)}
          >
            <option value="">All methods</option>
            <For each={methodsByCategory()}>
              {([cat, catMethods]) => (
                <optgroup label={cat}>
                  <Show when={catMethods.length > 1}>
                    <option value={`${cat}/*`}>All {cat}/* ({catMethods.length})</option>
                  </Show>
                  <For each={catMethods}>
                    {(m) => <option value={m}>{m}</option>}
                  </For>
                </optgroup>
              )}
            </For>
          </select>
          <select
            class="filter-select"
            value={filterDirection()}
            onChange={(e) => setFilterDirection(e.currentTarget.value as Direction | '')}
          >
            <option value="">All directions</option>
            <option value="sent">Sent</option>
            <option value="received">Received</option>
          </select>
          <select
            class="filter-select"
            value={filterType()}
            onChange={(e) => setFilterType(e.currentTarget.value as MessageType | '')}
          >
            <option value="">All types</option>
            <option value="request">Requests</option>
            <option value="response">Responses</option>
            <option value="notification">Notifications</option>
          </select>
          <Show when={sessions().length > 1}>
            <select
              class="filter-select"
              value={filterSession() === '' ? '' : String(filterSession())}
              onChange={(e) => {
                const v = e.currentTarget.value;
                setFilterSession(v === '' ? '' : parseInt(v, 10));
              }}
            >
              <option value="">All sessions</option>
              <For each={sessions()}>
                {(s) => (
                  <option value={String(s.index)}>
                    Session {s.index} ({s.count} msgs)
                  </option>
                )}
              </For>
            </select>
          </Show>
          <label class="filter-toggle" title="Hide window/logMessage, $/setTrace, $/logTrace, telemetry/event">
            <input
              type="checkbox"
              checked={hideLogging()}
              onChange={(e) => setHideLogging(e.currentTarget.checked)}
            />
            Hide logging
          </label>
          <div class="filter-actions">
            <button class="btn btn-small" onClick={() => expandAll(filtered().map(e => e.id))}>
              Expand All
            </button>
            <button class="btn btn-small" onClick={collapseAll}>
              Collapse All
            </button>
          </div>
          <span class="filter-count">{filtered().length} / {entries().length}</span>
        </section>

        <section class="trace-list">
          <For each={filtered()}>
            {(entry, i) => {
              const prevSession = () => {
                const idx = i();
                return idx > 0 ? filtered()[idx - 1]?.sessionIndex : undefined;
              };
              const showSeparator = () => {
                const ps = prevSession();
                return ps !== undefined && ps !== entry.sessionIndex;
              };
              return (
                <>
                  <Show when={showSeparator()}>
                    <div class="session-separator">
                      <span class="session-separator-line" />
                      <span class="session-separator-label">Session {entry.sessionIndex} — initialize</span>
                      <span class="session-separator-line" />
                    </div>
                  </Show>
                  <div ref={(el) => { entryRefs[entry.id] = el; }}>
                    <TraceEntryRow
                      entry={entry}
                      isExpanded={expandedIds().has(entry.id)}
                      onToggle={() => toggle(entry.id)}
                      pairedEntry={getPairedEntry(entry)}
                      onScrollTo={scrollToEntry}
                    />
                  </div>
                </>
              );
            }}
          </For>
        </section>
      </Show>
    </div>
  );
};

export default App;
