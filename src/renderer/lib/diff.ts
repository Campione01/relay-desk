export type DiffLineType = 'context' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Above this many cells the LCS table is skipped and the change is shown as remove-all/add-all. */
const MAX_CELLS = 400_000;

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff (longest common subsequence) between two texts. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const out: DiffLine[] = [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  for (let i = 0; i < start; i++) out.push({ type: 'context', text: a[i] ?? '', oldNo: i + 1, newNo: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  if (n * m > MAX_CELLS) {
    midA.forEach((text, i) => out.push({ type: 'del', text, oldNo: start + i + 1 }));
    midB.forEach((text, j) => out.push({ type: 'add', text, newNo: start + j + 1 }));
  } else {
    // table[i][j] = LCS length of midA[i..] and midB[j..]
    const table: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const row = table[i]!;
      const next = table[i + 1]!;
      for (let j = m - 1; j >= 0; j--) {
        row[j] = midA[i] === midB[j] ? next[j + 1]! + 1 : Math.max(next[j]!, row[j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        out.push({ type: 'context', text: midA[i]!, oldNo: start + i + 1, newNo: start + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || table[i + 1]![j]! >= table[i]![j + 1]!)) {
        out.push({ type: 'del', text: midA[i]!, oldNo: start + i + 1 });
        i++;
      } else {
        out.push({ type: 'add', text: midB[j]!, newNo: start + j + 1 });
        j++;
      }
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    out.push({ type: 'context', text: a[endA + k] ?? '', oldNo: endA + k + 1, newNo: endB + k + 1 });
  }
  return out;
}

export function diffStats(lines: readonly DiffLine[]): DiffStats {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'del') removed++;
  }
  return { added, removed };
}

/** Keeps changed lines plus `context` lines around them; gaps become a single null marker. */
export function collapseContext(lines: readonly DiffLine[], context = 3): Array<DiffLine | null> {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === 'context') return;
    for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) keep[k] = true;
  });
  const out: Array<DiffLine | null> = [];
  let gap = false;
  lines.forEach((line, index) => {
    if (keep[index]) {
      out.push(line);
      gap = false;
    } else if (!gap) {
      out.push(null);
      gap = true;
    }
  });
  return out;
}
