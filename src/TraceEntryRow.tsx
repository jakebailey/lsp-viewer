import { type Component, createSignal, createEffect, Show } from 'solid-js';
import type { TraceEntry } from './parser';
import { getCancelledRequestId, getProgressToken } from './parser';
import type { TrackedFile } from './fileTracker';
import { getHighlighter, type Highlighter } from './highlighter';
import { formatJson } from './formatJson';
import TraceFileContent from './TraceFileContent';
import HoverContent, { extractHoverContents } from './HoverContent';

function CopyButton(props: { text: string }) {
  const [copied, setCopied] = createSignal(false);
  function handleCopy(e: MouseEvent) {
    e.stopPropagation();
    navigator.clipboard.writeText(props.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }
  return (
    <button class="trace-copy-btn" onClick={handleCopy} title="Copy JSON body">
      {copied() ? '✓ Copied' : '📋 Copy'}
    </button>
  );
}

const FILE_METHODS = new Set(['textDocument/didOpen', 'textDocument/didChange', 'textDocument/didClose']);
const LOG_MESSAGE_METHODS = new Set(['window/logMessage', 'window/showMessage']);

const MESSAGE_TYPE_LABELS: Record<number, string> = {
  1: 'ERROR',
  2: 'WARN',
  3: 'INFO',
  4: 'LOG',
};

function getLogMessage(entry: TraceEntry): { level: string; levelClass: string; message: string; firstLine: string } | null {
  if (!LOG_MESSAGE_METHODS.has(entry.method) || !entry.body || typeof entry.body !== 'object') return null;
  const b = entry.body as { type?: number; message?: string };
  const level = MESSAGE_TYPE_LABELS[b.type ?? 0] ?? `TYPE ${b.type}`;
  const levelClass = b.type === 1 ? 'log-error' : b.type === 2 ? 'log-warn' : 'log-info';
  const message = b.message ?? '';
  const firstLine = message.split('\n')[0];
  return { level, levelClass, message, firstLine };
}

const TraceEntryRow: Component<{
  entry: TraceEntry;
  isExpanded: boolean;
  onToggle: () => void;
  pairedEntry?: TraceEntry;
  onScrollTo?: (id: number) => void;
  files?: Map<string, TrackedFile>;
  isDark?: boolean;
  isCancelled?: boolean;
  cancelledByEntry?: TraceEntry;
  cancelTargetEntry?: TraceEntry;
  requestLatency?: string;
  progressEntries?: TraceEntry[];
  progressOriginEntry?: TraceEntry;
}> = (props) => {
  const dirClass = () => props.entry.direction === 'sent' ? 'dir-sent' : 'dir-received';
  const typeClass = () => `type-${props.entry.messageType}`;
  const isError = () => props.entry.bodyLabel === 'Error';

  const dirArrow = () => props.entry.direction === 'sent' ? '→' : '←';
  const dirLabel = () => props.entry.direction === 'sent' ? 'Sent' : 'Recv';

  const typeBadge = () => {
    switch (props.entry.messageType) {
      case 'request': return 'REQ';
      case 'response': return 'RES';
      case 'notification': return 'NOT';
    }
  };

  const timeOnly = () => {
    const parts = props.entry.timestamp.split(' ');
    return parts[1] ?? props.entry.timestamp;
  };

  const formatBody = () => {
    if (!props.entry.body) return '';
    if (typeof props.entry.body === 'string') return props.entry.body;
    return formatJson(props.entry.body);
  };

  const [highlightedBody, setHighlightedBody] = createSignal('');
  const [highlighter, setHighlighter] = createSignal<Highlighter | null>(null);

  createEffect(() => {
    if (props.isExpanded && !highlighter()) {
      getHighlighter().then(h => setHighlighter(h));
    }
  });

  createEffect(() => {
    const h = highlighter();
    if (!props.isExpanded || !h) {
      setHighlightedBody('');
      return;
    }
    const body = formatBody();
    if (!body) return;
    const theme = (props.isDark ?? true) ? 'github-dark-default' : 'github-light-default';
    try {
      setHighlightedBody(h.codeToHtml(body, { lang: 'json', theme }));
    } catch {
      setHighlightedBody('');
    }
  });

  return (
    <div class={`trace-entry ${dirClass()} ${typeClass()} ${props.isExpanded ? 'expanded' : ''} ${props.isCancelled ? 'cancelled' : ''} ${isError() ? 'error-response' : ''}`}>
      <div class="trace-header" onClick={props.onToggle}>
        <span class="trace-time">{timeOnly()}</span>
        <span class={`trace-dir ${dirClass()}`}>{dirArrow()} {dirLabel()}</span>
        <span class={`trace-type-badge ${typeClass()} ${isError() ? 'type-error' : ''}`}>{isError() ? 'ERR' : typeBadge()}</span>
        <span class="trace-id" title={props.entry.requestId !== undefined ? `#${props.entry.requestId}` : ''}>{props.entry.requestId !== undefined ? `#${props.entry.requestId}` : ''}</span>
        <span class="trace-method">{props.entry.method}</span>
        {(() => {
          const log = getLogMessage(props.entry);
          if (!log) return null;
          return (
            <>
              <span class={`trace-log-level ${log.levelClass}`}>{log.level}</span>
              <span class="trace-log-message" title={log.message}>{log.firstLine}</span>
            </>
          );
        })()}
        <Show when={props.isCancelled}>
          <span class="trace-cancelled-badge">CANCELLED</span>
        </Show>
        <Show when={isError()}>
          <span class="trace-error-badge">ERROR</span>
        </Show>
        <Show when={props.entry.latencyRaw}>
          <span class={`trace-latency ${isError() ? 'latency-error' : ''}`}>{props.entry.latencyRaw}</span>
        </Show>
        <Show when={props.requestLatency && !props.entry.latencyRaw}>
          <span class="trace-latency trace-latency-inherited" title="Round-trip time from response">{props.requestLatency}</span>
        </Show>
        <Show when={props.pairedEntry}>
          <button
            class="trace-pair-link"
            onClick={(e) => {
              e.stopPropagation();
              props.onScrollTo?.(props.pairedEntry!.id);
            }}
            title={`Go to ${props.pairedEntry!.messageType === 'request' ? 'request' : 'response'}`}
          >
            {props.pairedEntry!.messageType === 'request' ? '⬆ req' : '⬇ res'}
          </button>
        </Show>
        <Show when={props.cancelledByEntry}>
          <button
            class="trace-pair-link trace-cancel-link"
            onClick={(e) => {
              e.stopPropagation();
              props.onScrollTo?.(props.cancelledByEntry!.id);
            }}
            title="Go to $/cancelRequest"
          >
            ✕ cancel
          </button>
        </Show>
        <Show when={props.cancelTargetEntry}>
          <button
            class="trace-pair-link trace-cancel-link"
            onClick={(e) => {
              e.stopPropagation();
              props.onScrollTo?.(props.cancelTargetEntry!.id);
            }}
            title={`Go to cancelled request: ${props.cancelTargetEntry!.method}`}
          >
            ✕ #{getCancelledRequestId(props.entry)} {props.cancelTargetEntry!.method}
          </button>
        </Show>
        <Show when={props.progressEntries && props.progressEntries.length > 0}>
          <button
            class="trace-pair-link trace-progress-link"
            onClick={(e) => {
              e.stopPropagation();
              props.onScrollTo?.(props.progressEntries![0].id);
            }}
            title={`${props.progressEntries!.length} progress notification(s)`}
          >
            ⏳ {props.progressEntries!.length} progress
          </button>
        </Show>
        <Show when={props.progressOriginEntry}>
          <button
            class="trace-pair-link trace-progress-link"
            onClick={(e) => {
              e.stopPropagation();
              props.onScrollTo?.(props.progressOriginEntry!.id);
            }}
            title={`Go to origin request: ${props.progressOriginEntry!.method}`}
          >
            ⏳ {getProgressToken(props.entry)} → {props.progressOriginEntry!.method}
          </button>
        </Show>
        <span class="trace-expand-icon">{props.isExpanded ? '▼' : '▶'}</span>
      </div>
      <Show when={props.isExpanded}>
        <div class="trace-body">
          {(() => {
            const log = getLogMessage(props.entry);
            if (log) {
              return (
                <>
                  <div class="trace-body-header">
                    <div class="trace-body-label">{log.level}:</div>
                    <CopyButton text={log.message} />
                  </div>
                  <pre class="trace-body-content"><code>{log.message}</code></pre>
                </>
              );
            }
            return (
              <>
                <div class="trace-body-header">
                  <div class="trace-body-label">{props.entry.bodyLabel}:</div>
                  <Show when={formatBody()}>
                    <CopyButton text={formatBody()} />
                  </Show>
                </div>
                <Show when={props.entry.method === 'textDocument/hover' && props.entry.bodyLabel === 'Result' && extractHoverContents(props.entry.body)}>
                  {(contents) => (
                    <HoverContent contents={contents()} isDark={props.isDark ?? true} />
                  )}
                </Show>
                <Show when={props.entry.body !== undefined} fallback={<div class="trace-body-empty">No content</div>}>
                  <Show when={highlightedBody()} fallback={
                    <pre class="trace-body-content"><code>{formatBody()}</code></pre>
                  }>
                    <div class="trace-body-highlighted" innerHTML={highlightedBody()} />
                  </Show>
                </Show>
              </>
            );
          })()}
          <Show when={props.files && FILE_METHODS.has(props.entry.method)}>
            <TraceFileContent
              entry={props.entry}
              files={props.files!}
              isDark={props.isDark ?? true}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
};

export default TraceEntryRow;

export function createExpandedSet() {
  const [expandedIds, setExpandedIds] = createSignal<Set<number>>(new Set());

  function toggle(id: number) {
    setExpandedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function expandAll(ids: number[]) {
    setExpandedIds(new Set(ids));
  }

  function collapseAll() {
    setExpandedIds(new Set<number>());
  }

  return { expandedIds, toggle, expandAll, collapseAll };
}
