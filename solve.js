// Faster drop-in for makefun-diff 1.0.0 (make.fun's own line diff).
//
// The answer for { old, new } is make.fun's own patch, byte for byte: lines
// cut after every "\n" only, common prefix kept, then common suffix, then
// Myers's greedy search (furthest-reaching path per diagonal, deletion
// preferred over insertion on ties, no edge-diagonal pruning, every run of
// equal lines followed as far as it goes), then hunks of up to 3 kept lines
// of context, runs at most 6 kept lines apart sharing a hunk.
//
// How this is faster than the reference while returning the same answer:
//  - Lines are interned once per case to small integer ids through a Map
//    keyed by the line string itself, so id equality IS string equality
//    (exact, no hashing) and every later comparison is one integer compare
//    on a typed array instead of a string compare.
//  - The Myers search keeps, for each d, one furthest-reaching old index
//    per diagonal in a dense Int32Array row (a trace of rows, one per d),
//    instead of one linked-list path object per (d, k) with a component
//    object per edit. The backtrack replays the reference's exact
//    candidate choice (same guards, same deletion-on-tie rule) from the
//    trace, so the reconstructed script is the reference's script.
//  - No array copies of the token lists (prefix/suffix are offsets), and
//    the patch is rendered straight from the original texts' line spans.

const KEEP = 0;
const DEL = 1;
const INS = 2;
const CONTEXT = 3;
/** No path on this diagonal at this d (an old index is never -2). */
const NONE = -2;

/**
 * Cut a text into lines (after every "\n"; a last line with no "\n" is a
 * line too; the empty text has none) and intern each line to an integer id
 * in the shared map, so the same line in both texts gets the same id.
 * Returns the ids and the [start, end) span of every line in the text.
 */
function tokenize(text, map) {
  let n = 0;
  let p = text.indexOf('\n');
  while (p !== -1) {
    n++;
    p = text.indexOf('\n', p + 1);
  }
  if (text.length > 0 && text.charCodeAt(text.length - 1) !== 10) n++;
  const ids = new Int32Array(n);
  const starts = new Int32Array(n);
  const ends = new Int32Array(n);
  let i = 0;
  let s = 0;
  while (i < n) {
    const e = text.indexOf('\n', s);
    const end = e === -1 ? text.length : e + 1;
    starts[i] = s;
    ends[i] = end;
    const line = text.slice(s, end);
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    ids[i] = id;
    s = end;
    i++;
  }
  return { ids, starts, ends };
}

/**
 * Myers's greedy search over the middle slices a[a0 .. a0+N) and
 * b[b0 .. b0+M), exactly as the reference states it, filling rk/rc with
 * the edit script's runs (kind, count) in forward order.
 *
 * The search keeps one furthest-reaching old index per diagonal per d, in
 * a trace of Int32Array rows. Row d holds diagonals k = -d..d at index
 * j = k + d (j even), plus two trailing NONE slots so the next row's reads
 * never run off its end; every slot a row is read at is written, so no row
 * is ever filled. The loop runs over j, carrying the previous j's insertion
 * source as this j's deletion source, and only the final diagonal
 * (k = N - M, the only one that can reach both ends) is ever checked for
 * the end. The slices are subarray views, so a read past a slice's end is
 * undefined and the snake needs a single bounds check.
 */
function myersRuns(aFull, bFull, a0, N, b0, M, rk, rc) {
  const a = aFull.subarray(a0, a0 + N);
  const b = bFull.subarray(b0, b0 + M);
  const rows = [];
  // d = 0: the snake from (-1, -1) on diagonal 0.
  let row = new Int32Array(3);
  row[1] = NONE;
  row[2] = NONE;
  let x = -1;
  let y = -1;
  while (x + 1 < N && a[x + 1] === b[y + 1]) {
    x++;
    y++;
  }
  row[0] = x;
  rows.push(row);
  let D = 0;
  let kF = 0;
  const kEnd = N - M;
  const Nm1 = N - 1;
  if (!(x + 1 >= N && y + 1 >= M)) {
    let done = false;
    for (let d = 1; d <= N + M && !done; d++) {
      const prev = rows[d - 1];
      const cur = new Int32Array(2 * d + 3);
      cur[2 * d + 1] = NONE;
      cur[2 * d + 2] = NONE;
      const jF = kEnd + d; // j of the final diagonal this d, if it is visited
      const Md = M - d; // the insertion guard's constant this d
      let xDelPrev = NONE; // prev[j - 2], carried from the previous j
      for (let j = 0; j <= 2 * d; j += 2) {
        const xInsPrev = prev[j]; // prev row's path on diagonal k + 1
        // A move past either text's end is no candidate.
        const canRemove = xDelPrev !== NONE && xDelPrev < Nm1;
        const canAdd = xInsPrev !== NONE && xInsPrev - j < Md;
        if (!canRemove && !canAdd) {
          cur[j] = NONE;
          xDelPrev = xInsPrev;
          continue;
        }
        // Furthest into the old text wins; a deletion wins a tie.
        const byDel = canRemove ? xDelPrev + 1 : NONE;
        const byIns = canAdd ? xInsPrev : NONE;
        let xx = byDel >= byIns ? byDel : byIns;
        let yy = xx - j + d;
        // Follow every run of equal lines as far as it goes.
        while (xx + 1 < N && a[xx + 1] === b[yy + 1]) {
          xx++;
          yy++;
        }
        cur[j] = xx;
        xDelPrev = xInsPrev;
      }
      // Only the final diagonal can reach both ends, so only it is checked.
      if (jF >= 0 && jF <= 2 * d && (jF & 1) === 0 && cur[jF] + 1 >= N) {
        D = d;
        kF = kEnd;
        done = true;
      }
      rows.push(cur);
    }
    if (!done) throw new Error('makefun-diff: the search ended without reaching both ends');
  }

  // Backtrack: replay the same candidate choice from the trace.
  const rkRev = [];
  const rcRev = [];
  let d = D;
  let k = kF;
  let xEnd = rows[d][k + d];
  while (d > 0) {
    const prev = rows[d - 1];
    const jDel = k + d - 2;
    const jIns = k + d;
    const xDelPrev = jDel >= 0 ? prev[jDel] : NONE;
    const xInsPrev = prev[jIns];
    const canRemove = xDelPrev !== NONE && xDelPrev + 1 < N;
    const canAdd = xInsPrev !== NONE && xInsPrev - k < M;
    const byDel = canRemove ? xDelPrev + 1 : NONE;
    const byIns = canAdd ? xInsPrev : NONE;
    let prevK;
    let xAfterEdit;
    let kind;
    if (byDel >= byIns) {
      prevK = k - 1;
      xAfterEdit = byDel;
      kind = DEL;
    } else {
      prevK = k + 1;
      xAfterEdit = byIns;
      kind = INS;
    }
    const snake = xEnd - xAfterEdit;
    if (snake > 0) {
      rkRev.push(KEEP);
      rcRev.push(snake);
    }
    rkRev.push(kind);
    rcRev.push(1);
    d--;
    k = prevK;
    xEnd = rows[d][k + d];
  }
  if (xEnd + 1 > 0) {
    rkRev.push(KEEP);
    rcRev.push(xEnd + 1);
  }
  for (let i = rkRev.length - 1; i >= 0; i--) {
    const kd = rkRev[i];
    const c = rcRev[i];
    if (rk.length > 0 && rk[rk.length - 1] === kd) rc[rc.length - 1] += c;
    else {
      rk.push(kd);
      rc.push(c);
    }
  }
}

/**
 * A line as the patch writes it, pushed as pieces onto out (the join at
 * the end does the concatenating): the op, the line, a newline, and "%" on
 * a line of its own when the line had none.
 */
function written(out, op, text, start, end) {
  out.push(op);
  out.push(text.slice(start, end));
  if (end <= start || text.charCodeAt(end - 1) !== 10) out.push('\n%\n');
}

/** make.fun's own patch of input.old into input.new, as one string. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const oldText = input.old;
  const newText = input.new;
  // One interning map per case: each case is answered alone.
  const map = new Map();
  const A = tokenize(oldText, map);
  const B = tokenize(newText, map);
  const a = A.ids;
  const b = B.ids;
  const n = a.length;
  const m = b.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const rk = [];
  const rc = [];
  if (prefix > 0) {
    rk.push(KEEP);
    rc.push(prefix);
  }
  myersRuns(a, b, prefix, n - prefix - suffix, prefix, m - prefix - suffix, rk, rc);
  if (suffix > 0) {
    rk.push(KEEP);
    rc.push(suffix);
  }

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < rk.length; i++) {
    const kind = rk[i];
    const count = rc[i];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes.length > 0 ? changes[changes.length - 1] : undefined;
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DEL) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks.length > 0 ? hunks[hunks.length - 1] : undefined;
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) written(out, '=', oldText, A.starts[at], A.ends[at]);
      for (let i = 0; i < c.dels; i++) written(out, '-', oldText, A.starts[c.o + i], A.ends[c.o + i]);
      for (let i = 0; i < c.ins; i++) written(out, '+', newText, B.starts[c.p + i], B.ends[c.p + i]);
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) written(out, '=', oldText, A.starts[at], A.ends[at]);
  }
  return out.join('');
}
