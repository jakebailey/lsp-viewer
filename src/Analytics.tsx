import { type Component, createMemo, For, Show } from 'solid-js';
import type { TraceEntry } from './parser';

interface MethodStats {
  method: string;
  count: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  avgMs: number;
  errors: number;
  cancelled: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function formatMs(ms: number): string {
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

const Analytics: Component<{
  entries: TraceEntry[];
  pairs: Map<string, { request?: TraceEntry; response?: TraceEntry }>;
  cancellations: Map<string, TraceEntry>;
  onScrollTo: (id: number) => void;
}> = (props) => {
  const methodStats = createMemo(() => {
    const map = new Map<string, { latencies: number[]; count: number; errors: number; cancelled: number }>();

    for (const [key, pair] of props.pairs) {
      if (!pair.request) continue;
      const method = pair.request.method;
      if (!map.has(method)) map.set(method, { latencies: [], count: 0, errors: 0, cancelled: 0 });
      const stats = map.get(method)!;
      stats.count++;
      if (pair.response?.latencyMs !== undefined) {
        stats.latencies.push(pair.response.latencyMs);
      }
      if (pair.response?.bodyLabel === 'Error') stats.errors++;
      if (props.cancellations.has(key)) stats.cancelled++;
    }

    const result: MethodStats[] = [];
    for (const [method, s] of map) {
      const sorted = [...s.latencies].sort((a, b) => a - b);
      result.push({
        method,
        count: s.count,
        minMs: sorted[0] ?? 0,
        maxMs: sorted[sorted.length - 1] ?? 0,
        p50Ms: percentile(sorted, 50),
        p95Ms: percentile(sorted, 95),
        avgMs: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
        errors: s.errors,
        cancelled: s.cancelled,
      });
    }

    return result.sort((a, b) => b.p95Ms - a.p95Ms);
  });

  const slowestRequests = createMemo(() => {
    const items: Array<{ entry: TraceEntry; latencyMs: number; isError: boolean }> = [];
    for (const [, pair] of props.pairs) {
      if (pair.response?.latencyMs !== undefined && pair.request) {
        items.push({
          entry: pair.request,
          latencyMs: pair.response.latencyMs,
          isError: pair.response.bodyLabel === 'Error',
        });
      }
    }
    return items.sort((a, b) => b.latencyMs - a.latencyMs).slice(0, 20);
  });

  const totalRequests = createMemo(() => {
    let total = 0;
    for (const s of methodStats()) total += s.count;
    return total;
  });

  const totalErrors = createMemo(() => {
    let total = 0;
    for (const s of methodStats()) total += s.errors;
    return total;
  });

  const overallP95 = createMemo(() => {
    const all: number[] = [];
    for (const [, pair] of props.pairs) {
      if (pair.response?.latencyMs !== undefined) all.push(pair.response.latencyMs);
    }
    all.sort((a, b) => a - b);
    return percentile(all, 95);
  });

  const maxBarMs = createMemo(() => {
    const stats = methodStats();
    if (stats.length === 0) return 100;
    return Math.max(...stats.map(s => s.p95Ms), 1);
  });

  return (
    <div class="analytics">
      <div class="analytics-summary">
        <div class="analytics-card">
          <div class="analytics-card-value">{totalRequests()}</div>
          <div class="analytics-card-label">Request/Response Pairs</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-card-value">{formatMs(overallP95())}</div>
          <div class="analytics-card-label">Overall p95 Latency</div>
        </div>
        <div class="analytics-card analytics-card-error">
          <div class="analytics-card-value">{totalErrors()}</div>
          <div class="analytics-card-label">Errors</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-card-value">{methodStats().length}</div>
          <div class="analytics-card-label">Unique Methods</div>
        </div>
      </div>

      <div class="analytics-section">
        <h3 class="analytics-section-title">Latency by Method</h3>
        <Show when={methodStats().length > 0} fallback={
          <div class="analytics-empty">No request/response pairs with latency data</div>
        }>
          <table class="analytics-table">
            <thead>
              <tr>
                <th class="analytics-th-method">Method</th>
                <th class="analytics-th-num">Count</th>
                <th class="analytics-th-num">p50</th>
                <th class="analytics-th-num">p95</th>
                <th class="analytics-th-num">Max</th>
                <th class="analytics-th-bar">Distribution</th>
                <th class="analytics-th-num">Err</th>
              </tr>
            </thead>
            <tbody>
              <For each={methodStats()}>
                {(s) => {
                  const barWidth = () => Math.max((s.p95Ms / maxBarMs()) * 100, 1);
                  const p50Width = () => Math.max((s.p50Ms / maxBarMs()) * 100, 1);
                  return (
                    <tr class="analytics-row">
                      <td class="analytics-method">{s.method}</td>
                      <td class="analytics-num">{s.count}</td>
                      <td class="analytics-num">{formatMs(s.p50Ms)}</td>
                      <td class="analytics-num analytics-num-bold">{formatMs(s.p95Ms)}</td>
                      <td class="analytics-num">{formatMs(s.maxMs)}</td>
                      <td class="analytics-bar-cell">
                        <div class="analytics-bar-track">
                          <div class="analytics-bar-p95" style={`width: ${barWidth()}%`} />
                          <div class="analytics-bar-p50" style={`width: ${p50Width()}%`} />
                        </div>
                      </td>
                      <td class={`analytics-num ${s.errors > 0 ? 'analytics-num-error' : ''}`}>
                        {s.errors > 0 ? s.errors : '—'}
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </div>

      <div class="analytics-section">
        <h3 class="analytics-section-title">Slowest Requests (Top 20)</h3>
        <Show when={slowestRequests().length > 0} fallback={
          <div class="analytics-empty">No latency data available</div>
        }>
          <div class="analytics-slow-list">
            <For each={slowestRequests()}>
              {(item) => (
                <button
                  class={`analytics-slow-item ${item.isError ? 'analytics-slow-error' : ''}`}
                  onClick={() => props.onScrollTo(item.entry.id)}
                >
                  <span class="analytics-slow-latency">{formatMs(item.latencyMs)}</span>
                  <span class="analytics-slow-method">{item.entry.method}</span>
                  <Show when={item.entry.requestId}>
                    <span class="analytics-slow-id">#{item.entry.requestId}</span>
                  </Show>
                  <span class="analytics-slow-time">{item.entry.timestamp}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Analytics;
