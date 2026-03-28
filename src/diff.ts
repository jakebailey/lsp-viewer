export interface DiffLine {
  type: 'same' | 'add' | 'remove';
  text: string;
  oldLineNum?: number;
  newLineNum?: number;
}

/**
 * Simple line-level diff using the Myers algorithm (simple O(ND) version).
 * Returns an array of DiffLine entries.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  // Use LCS-based approach for reasonable sizes
  const lcs = computeLCS(oldLines, newLines);

  const result: DiffLine[] = [];
  let oi = 0;
  let ni = 0;
  let oldNum = 1;
  let newNum = 1;

  for (const [matchOld, matchNew] of lcs) {
    // Lines removed before this match
    while (oi < matchOld) {
      result.push({ type: 'remove', text: oldLines[oi], oldLineNum: oldNum++ });
      oi++;
    }
    // Lines added before this match
    while (ni < matchNew) {
      result.push({ type: 'add', text: newLines[ni], newLineNum: newNum++ });
      ni++;
    }
    // Matching line
    result.push({ type: 'same', text: oldLines[oi], oldLineNum: oldNum++, newLineNum: newNum++ });
    oi++;
    ni++;
  }

  // Remaining removals
  while (oi < oldLines.length) {
    result.push({ type: 'remove', text: oldLines[oi], oldLineNum: oldNum++ });
    oi++;
  }
  // Remaining additions
  while (ni < newLines.length) {
    result.push({ type: 'add', text: newLines[ni], newLineNum: newNum++ });
    ni++;
  }

  return result;
}

/**
 * Compute LCS indices using a standard DP approach.
 * Returns array of [oldIndex, newIndex] pairs for matching lines.
 * For large files, falls back to a simpler approach.
 */
function computeLCS(oldLines: string[], newLines: string[]): [number, number][] {
  const m = oldLines.length;
  const n = newLines.length;

  // For very large files, use a greedy matching approach
  if (m * n > 1_000_000) {
    return greedyMatch(oldLines, newLines);
  }

  // Standard DP
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: [number, number][] = [];
  let i = m;
  let j = n;
  while (i > 0 && j > 0) {
    if (oldLines[i - 1] === newLines[j - 1]) {
      result.push([i - 1, j - 1]);
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result.reverse();
}

/** Greedy line matching for large files */
function greedyMatch(oldLines: string[], newLines: string[]): [number, number][] {
  const newLineMap = new Map<string, number[]>();
  for (let j = 0; j < newLines.length; j++) {
    const line = newLines[j];
    if (!newLineMap.has(line)) newLineMap.set(line, []);
    newLineMap.get(line)!.push(j);
  }

  const result: [number, number][] = [];
  let lastJ = -1;
  for (let i = 0; i < oldLines.length; i++) {
    const candidates = newLineMap.get(oldLines[i]);
    if (!candidates) continue;
    // Find first candidate after lastJ
    for (const j of candidates) {
      if (j > lastJ) {
        result.push([i, j]);
        lastJ = j;
        break;
      }
    }
  }

  return result;
}

/**
 * Collapse a diff to only show changed regions with context lines.
 */
export function collapseDiff(lines: DiffLine[], contextLines = 3): (DiffLine | { type: 'collapse'; count: number })[] {
  // Find which lines are "interesting" (changed or near a change)
  const interesting = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'same') {
      for (let j = Math.max(0, i - contextLines); j <= Math.min(lines.length - 1, i + contextLines); j++) {
        interesting.add(j);
      }
    }
  }

  // If everything is interesting or diff is small, return as-is
  if (interesting.size >= lines.length || lines.length <= 30) {
    return lines;
  }

  const result: (DiffLine | { type: 'collapse'; count: number })[] = [];
  let collapsed = 0;

  for (let i = 0; i < lines.length; i++) {
    if (interesting.has(i)) {
      if (collapsed > 0) {
        result.push({ type: 'collapse', count: collapsed });
        collapsed = 0;
      }
      result.push(lines[i]);
    } else {
      collapsed++;
    }
  }

  if (collapsed > 0) {
    result.push({ type: 'collapse', count: collapsed });
  }

  return result;
}
