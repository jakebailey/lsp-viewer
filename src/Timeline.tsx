import { type Component, createMemo, For, Show } from 'solid-js';
import type { TraceEntry } from './parser';

const Timeline: Component<{
  entries: TraceEntry[];
  pairs: Map<string, { request?: TraceEntry; response?: TraceEntry }>;
  cancellations: Map<string, TraceEntry>;
  onScrollTo: (id: number) => void;
}> = (props) => {
  // Only show request/response pairs that have both sides
  const timelineItems = createMemo(() => {
    const items: Array<{
      requestId: string;
      method: string;
      request: TraceEntry;
      response?: TraceEntry;
      startMs: number;
      endMs: number;
      durationMs: number;
      isCancelled: boolean;
      isError: boolean;
    }> = [];

    // Parse timestamp to ms since start of trace
    const base = props.entries.length > 0 ? parseTimestamp(props.entries[0].timestamp) : 0;

    for (const [reqId, pair] of props.pairs) {
      if (!pair.request) continue;
      const startMs = parseTimestamp(pair.request.timestamp) - base;
      const endMs = pair.response ? parseTimestamp(pair.response.timestamp) - base : startMs + 100; // open-ended
      const durationMs = pair.response?.latencyMs ?? (endMs - startMs);
      items.push({
        requestId: reqId,
        method: pair.request.method,
        request: pair.request,
        response: pair.response,
        startMs,
        endMs,
        durationMs,
        isCancelled: props.cancellations.has(reqId),
        isError: pair.response?.bodyLabel === 'Error',
      });
    }

    items.sort((a, b) => a.startMs - b.startMs);
    return items;
  });

  const maxTime = createMemo(() => {
    const items = timelineItems();
    if (items.length === 0) return 1000;
    return Math.max(...items.map(i => i.endMs), 1000);
  });

  const formatMs = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  return (
    <div class="timeline">
      <div class="timeline-header">
        <span class="timeline-label">Method</span>
        <span class="timeline-scale">
          <span>0</span>
          <span>{formatMs(maxTime() / 4)}</span>
          <span>{formatMs(maxTime() / 2)}</span>
          <span>{formatMs(maxTime() * 3 / 4)}</span>
          <span>{formatMs(maxTime())}</span>
        </span>
      </div>
      <div class="timeline-body">
        <For each={timelineItems()}>
          {(item) => {
            const left = () => (item.startMs / maxTime()) * 100;
            const width = () => Math.max(((item.endMs - item.startMs) / maxTime()) * 100, 0.3);
            const barClass = () => {
              if (item.isError) return 'timeline-bar-error';
              if (item.isCancelled) return 'timeline-bar-cancelled';
              if (!item.response) return 'timeline-bar-pending';
              return 'timeline-bar-ok';
            };
            return (
              <div class="timeline-row">
                <button
                  class="timeline-method"
                  onClick={() => props.onScrollTo(item.request.id)}
                  title={`${item.method} #${item.requestId} — ${formatMs(item.durationMs)}`}
                >
                  <span class="timeline-method-text">{item.method}</span>
                  <span class="timeline-req-id">#{item.requestId}</span>
                </button>
                <div class="timeline-track">
                  <div
                    class={`timeline-bar ${barClass()}`}
                    style={`left: ${left()}%; width: ${width()}%`}
                    title={`${formatMs(item.durationMs)}${item.isCancelled ? ' (cancelled)' : ''}${item.isError ? ' (error)' : ''}`}
                  >
                    <Show when={width() > 3}>
                      <span class="timeline-bar-label">{formatMs(item.durationMs)}</span>
                    </Show>
                  </div>
                </div>
              </div>
            );
          }}
        </For>
      </div>
      <Show when={timelineItems().length === 0}>
        <div class="timeline-empty">No request/response pairs found</div>
      </Show>
    </div>
  );
};

function parseTimestamp(ts: string): number {
  // "2026-03-27 21:18:04.090" or "9:31:59 PM" format
  if (ts.includes('-')) {
    const d = new Date(ts.replace(' ', 'T'));
    return d.getTime();
  }
  // Old format — just use relative positioning
  const parts = ts.match(/(\d+):(\d+):(\d+)\s*(AM|PM)?/i);
  if (!parts) return 0;
  let h = parseInt(parts[1]);
  const m = parseInt(parts[2]);
  const s = parseInt(parts[3]);
  if (parts[4]?.toUpperCase() === 'PM' && h !== 12) h += 12;
  if (parts[4]?.toUpperCase() === 'AM' && h === 12) h = 0;
  return (h * 3600 + m * 60 + s) * 1000;
}

export default Timeline;
