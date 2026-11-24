// SPEC-SKILLS Phase 5b — a tiny pure line differ for the promote_skill Confirm card (no diff util
// exists in the web bundle). Common-prefix/suffix trim, then an LCS walk over the middle; when
// either middle exceeds LCS_MAX_LINES the card falls back to a full-replace view (del-all/add-all)
// rather than an O(n·m) blowup — bodies cap at 64 KB, but a pathological line count must not freeze
// the dock. Pure function ⇒ unit-tested beside the governance suite.

export interface DiffRow {
  t: 'same' | 'add' | 'del';
  line: string;
}

const LCS_MAX_LINES = 1500;

/** Line diff a → b. Every input line appears exactly once as same/del (from a) or same/add (from b). */
export function diffLines(a: string, b: string): DiffRow[] {
  const A = a.split('\n');
  const B = b.split('\n');
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }
  const rows: DiffRow[] = [];
  for (let i = 0; i < start; i++) rows.push({ t: 'same', line: A[i]! });
  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  if (midA.length > LCS_MAX_LINES || midB.length > LCS_MAX_LINES) {
    for (const line of midA) rows.push({ t: 'del', line });
    for (const line of midB) rows.push({ t: 'add', line });
  } else if (midA.length > 0 || midB.length > 0) {
    // dp[i][j] = LCS length of midA[i..] vs midB[j..], flattened row-major (≤ ~1501² u32 ≈ 9 MB
    // transient worst case at the fallback threshold — allocated only while diffing).
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j]
          ? dp[(i + 1) * w + j + 1]! + 1
          : Math.max(dp[(i + 1) * w + j]!, dp[i * w + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        rows.push({ t: 'same', line: midA[i]! });
        i++;
        j++;
      } else if (dp[(i + 1) * w + j]! >= dp[i * w + j + 1]!) {
        rows.push({ t: 'del', line: midA[i]! });
        i++;
      } else {
        rows.push({ t: 'add', line: midB[j]! });
        j++;
      }
    }
    for (; i < n; i++) rows.push({ t: 'del', line: midA[i]! });
    for (; j < m; j++) rows.push({ t: 'add', line: midB[j]! });
  }
  for (let i = endA; i < A.length; i++) rows.push({ t: 'same', line: A[i]! });
  return rows;
}
