import { createHighlighter } from 'shiki';
import type { HighlighterGeneric, BundledLanguage, BundledTheme } from 'shiki';

export type Highlighter = HighlighterGeneric<BundledLanguage, BundledTheme>;

let highlighterPromise: Promise<Highlighter> | undefined;

export async function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: ['github-dark-default', 'github-light-default'],
      langs: ['json'],
    });
  }
  return highlighterPromise;
}

export async function loadLang(highlighter: Highlighter, lang: string): Promise<boolean> {
  const loaded = highlighter.getLoadedLanguages();
  if (loaded.includes(lang as BundledLanguage)) return true;
  try {
    await highlighter.loadLanguage(lang as BundledLanguage);
    return true;
  } catch {
    // not available
  }
  return false;
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
