// parse.js — a fast CommonMark + GFM renderer, byte-identical to marked 18.1.3
// with its defaults (gfm true, breaks false, pedantic false, async false).
//
// Written from scratch: a single-pass block parser over lines, a char-by-char
// inline scanner with a delimiter stack, direct HTML emission into chunks.
// No dependencies, no regex in hot paths, no clock, no environment reads,
// no state kept between parse() calls (every case renders alone).

// ---------------------------------------------------------------------------
// Character classification
// ---------------------------------------------------------------------------

const PUNCT = new Uint8Array(128);
for (const c of "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~") PUNCT[c.charCodeAt(0)] = 1;

function isSpace(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
}

// ASCII punctuation, or a Unicode punctuation/symbol character (CommonMark
// "Unicode punctuation": general categories P and S). Letters and numbers
// (including CJK, Greek, Cyrillic, Hangul, the vulgar fractions) are not.
function isPunct(c) {
  if (c < 128) return PUNCT[c] === 1;
  if (c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000) return false; // spaces
  if (c >= 0x41 && c <= 0x5a) return false;
  if (c >= 0x61 && c <= 0x7a) return false;
  if (c >= 0xc0 && c <= 0x2ff && c !== 0xd7 && c !== 0xf7) return false; // Latin-1 + Latin Extended
  if (c >= 0x370 && c <= 0x3ff) return false; // Greek
  if (c >= 0x400 && c <= 0x4ff) return false; // Cyrillic
  if (c >= 0x590 && c <= 0x5ff) return false; // Hebrew
  if (c >= 0x600 && c <= 0x6ff) return false; // Arabic
  if (c >= 0x3040 && c <= 0x30ff) return false; // Hiragana + Katakana
  if (c >= 0x4e00 && c <= 0x9fff) return false; // CJK Unified
  if (c >= 0xac00 && c <= 0xd7af) return false; // Hangul syllables
  if (c >= 0xfb00 && c <= 0xfb4f) return false; // ligatures etc.
  if (c === 0xbd || c === 0xbc || c === 0xbe || c === 0xb2 || c === 0xb3 || c === 0xb9) return false; // vulgar fractions, superscripts
  if (c >= 0x30 && c <= 0x39) return false;
  return true;
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

function isAlpha(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 128 && !isPunct(c) && !isSpace(c));
}

function isWhitespace(c) {
  return isSpace(c) || c === 0xa0 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f || c === 0x205f || c === 0x3000;
}

// Left-flanking / right-flanking per CommonMark 0.31.2 appendix.
// prev / next are char codes, or -1 at the string ends.
function isLeftFlanking(prev, next) {
  if (next === -1 || isWhitespace(next)) return false;
  if (!isPunct(next)) return true;
  return prev === -1 || isWhitespace(prev) || isPunct(prev);
}

function isRightFlanking(prev, next) {
  if (prev === -1 || isWhitespace(prev)) return false;
  if (!isPunct(prev)) return true;
  return next === -1 || isWhitespace(next) || isPunct(next);
}

// Flanking as marked's GFM delimiter regexes compute it: '~' is NOT
// punctuation there (its GFM punct/notPunctSpace classes exclude '~',
// since '~' is itself the strikethrough delimiter). A '*' run followed
// by '~~' is therefore both-flanking in marked (RDelim group 6) and
// subject to the rule-of-3 deferral, while standard CommonMark flanking
// would call it closer-only. Used ONLY for emphasis/strikethrough
// delimiter runs (collection and the autolink urlLimit scan).
function isPunctEm(c) { return c !== 126 && isPunct(c); }

function isLeftFlankingEm(prev, next) {
  if (next === -1 || isWhitespace(next)) return false;
  if (!isPunctEm(next)) return true;
  return prev === -1 || isWhitespace(prev) || isPunctEm(prev);
}

function isRightFlankingEm(prev, next) {
  if (prev === -1 || isWhitespace(prev)) return false;
  if (!isPunctEm(prev)) return true;
  return next === -1 || isWhitespace(next) || isPunctEm(next);
}

// ---------------------------------------------------------------------------
// Escaping (marked's escape: & < > " ')
// ---------------------------------------------------------------------------

function escapeText(out, s, start, end) {
  let i = start;
  let chunk = start;
  for (; i < end; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > chunk) out.push(s.slice(chunk, i));
      out.push(rep);
      chunk = i + 1;
    }
  }
  if (end > chunk) out.push(s.slice(chunk, end));
}

function escapeStr(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  const out = [];
  escapeText(out, s, 0, s.length);
  return out.join('');
}

// String version of escapeNoEncodeText (preserves &...; entity references).
function escapeNoEncodeStr(s) {
  if (s.indexOf('&') < 0 && s.indexOf('<') < 0 && s.indexOf('>') < 0 && s.indexOf('"') < 0 && s.indexOf("'") < 0) return s;
  const out = [];
  escapeNoEncodeText(out, s, 0, s.length);
  return out.join('');
}

// ---------------------------------------------------------------------------
// Entities (marked's behaviour, verified against its output):
//   &#<dec>; / &#[xX]<hex>;  -> the code point (0 -> U+FFFD; out of range /
//   surrogate -> left literal, with & escaped). No semicolon -> literal.
//   &<letters><digits>*;     -> passed through unchanged (marked does not
//                              validate named entities).
//   anything else starting & -> the & is escaped.
// Returns the decoded string and the consumed length, or null.
// ---------------------------------------------------------------------------

function entityAt(s, i, end) {
  // s[i] === '&'
  if (i + 1 >= end) return null;
  const c1 = s.charCodeAt(i + 1);
  if (c1 === 35) {
    // numeric
    let j = i + 2;
    let hex = false;
    if (j < end && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    let v = 0;
    let digits = 0;
    while (j < end) {
      const c = s.charCodeAt(j);
      let d = -1;
      if (c >= 48 && c <= 57) d = c - 48;
      else if (hex && c >= 97 && c <= 102) d = c - 87;
      else if (hex && c >= 65 && c <= 70) d = c - 55;
      else break;
      if (v > 0x10ffff) { /* keep scanning but it stays out of range */ }
      v = v * (hex ? 16 : 10) + d;
      digits++;
      j++;
    }
    if (digits === 0 || j >= end || s.charCodeAt(j) !== 59) return null;
    if (v > 0x10ffff) return null;
    if (v === 0 || (v >= 0xd800 && v <= 0xdfff)) return ['\ufffd', j + 1 - i];
    return [String.fromCodePoint(v), j + 1 - i];
  }
  if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) {
    let j = i + 1;
    while (j < end) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
      else break;
    }
    if (j < end && s.charCodeAt(j) === 59 && j > i + 1) return [s.slice(i, j + 1), j + 1 - i];
    return null;
  }
  return null;
}

// Strip up to n columns of leading indentation from a string (fenced
// code content loses the opening fence's indent). A tab that straddles
// the boundary becomes spaces for its remainder.
function stripIndent(s, n) {
  let i = 0, col = 0;
  while (i < s.length && col < n) {
    const c = s.charCodeAt(i);
    if (c === 32) { i++; col++; }
    else if (c === 9) {
      const next = col + 4 - (col % 4);
      if (next > n) return ' '.repeat(next - n) + s.slice(i + 1);
      i++; col = next;
    } else break;
  }
  return s.slice(i);
}

// Expand leading tabs of a paragraph line to spaces, using the virtual
// column as the starting column (a tab advances to the next multiple of
// 4). Marked expands a tab at the start of a paragraph line inside a
// container (quote/list) but keeps it literal in top-level fenced code
// content, so this is applied only to paragraph continuation lines,
// never to fence content or curRest() globally.
function expandParaTabs(s, startCol) {
  let col = startCol, i = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else if (c === 32) { out += ' '; col++; i++; }
    else break;
  }
  return out + s.slice(i);
}

// Fenced code content line: expand leading tabs to spaces using the
// ABSOLUTE column (tabs align to absolute tab stops), then drop the
// columns before the fence's own column.
// marked's fenced-code indent compensation (Dt) strips up to N leading
// whitespace CHARACTERS (not columns) from each content line, where N is
// the whitespace before the opening backtick fence. A tab straddling the
// boundary is removed whole (e.g. '   ```' + '\tfoo' -> 'foo'), unlike
// the column-based stripIndent which would leave a space behind.
function stripFenceChars(s, n) {
  let i = 0;
  while (i < n && i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9) i++;
    else break;
  }
  return s.slice(i);
}

function fenceContentLine(s, startCol, fenceCol) {
  let col = startCol, i = 0, out = '';
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === 32) { out += ' '; col++; i++; }
    else if (c === 9) { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else break;
  }
  const rest = s.slice(i);
  const drop = Math.max(0, fenceCol - startCol);
  return (out.length >= drop ? out.slice(drop) : '') + rest;
}

// ---------------------------------------------------------------------------
// Inline parsing — link grammar helpers
// ---------------------------------------------------------------------------

function normalizeLabel(s) {
  // Unicode full case folding for the cases toLowerCase() misses:
  // sharp s and Latin ligatures fold to their expansions.
  s = s.replace(/ß/g, 'ss').replace(/ẞ/g, 'ss')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl').replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
  let out = '';
  let pendingSpace = false;
  let started = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) {
      if (started) pendingSpace = true;
    } else {
      if (pendingSpace) { out += ' '; pendingSpace = false; }
      started = true;
      out += s[i].toLowerCase();
    }
  }
  return out;
}

// Resolve backslash escapes in a destination or title: \ + ASCII punctuation
// becomes the punctuation; anything else keeps the backslash.
function resolveEscapes(s) {
  if (s.indexOf('\\') < 0) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < s.length && PUNCT[s.charCodeAt(i + 1)] === 1) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// [label] at i (text[i] === '['). Returns {label, next} or null.
// A label may not contain an unescaped '[' (CommonMark: link labels have
// no unescaped brackets), no blank line inside, at most 999 characters.
function parseLinkLabel(text, i) {
  const n = text.length;
  let depth = 1;
  let j = i + 1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92) { j += 2; continue; }
    if (c === 91) return null; // unescaped '[' inside a label: invalid
    else if (c === 93) {
      depth--;
      if (depth === 0) {
        const label = text.slice(i + 1, j);
        if (label.length > 999) return null;
        return { label, next: j + 1 };
      }
    } else if (c === 10 && j + 1 < n && text.charCodeAt(j + 1) === 10) return null;
    j++;
  }
  return null;
}

function skipInlineWs(text, i) {
  const n = text.length;
  while (i < n) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

// Would a link form with the label ending at ']' (position j), whose
// '[' is at bPos? The code-span search must only stop at a ']' when the
// link actually forms: a valid label shape (LABEL_RE) is not enough —
// the inline dest must parse or the reference must resolve. Otherwise
// the code span wins and crosses the ']' (e.g. [lexer path ``project`]
// [empty-3] forms the giant code span because the ref doesn't resolve).
function linkWouldForm(text, bPos, j, refs) {
  const n = text.length;
  const labelText = text.slice(bPos + 1, j);
  if (!labelReFull(labelText + ']')) return false;
  const after = j + 1;
  if (after < n && text.charCodeAt(after) === 40) {
    // inline link: (dest "title")
    let k = skipInlineWs(text, after + 1);
    const d = parseLinkDest(text, k);
    if (d) {
      k = skipInlineWs(text, d.next);
      if (k < n && text.charCodeAt(k) === 41) return true;
      const t = parseLinkTitle(text, k);
      if (t) {
        k = skipInlineWs(text, t.next);
        if (k < n && text.charCodeAt(k) === 41) return true;
      }
    }
    // fallback to shortcut reference
    return !!refs.get(normalizeLabel(labelText));
  }
  if (after < n && text.charCodeAt(after) === 91) {
    const lab = parseLinkLabel(text, after);
    if (!lab) return false;
    const key = lab.label === '' ? normalizeLabel(labelText) : normalizeLabel(lab.label);
    return !!refs.get(key);
  }
  return false;
}

// Link destination at i (after '(' and any whitespace). Returns {dest, next}
// or null. dest is the raw destination (escapes unresolved).
function parseLinkDest(text, i) {
  const n = text.length;
  if (i >= n) return null;
  if (text.charCodeAt(i) === 60) {
    // <...>
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 62) return { dest: text.slice(i + 1, j), next: j + 1 };
      if (c === 60 || c === 10) return null;
      if (c === 92) j += 2;
      else j++;
    }
    return null;
  }
  let j = i;
  let depth = 0;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (c === 92 && j + 1 < n && PUNCT[text.charCodeAt(j + 1)] === 1) { j += 2; continue; }
    if (c === 40) { depth++; j++; continue; }
    if (c === 41) {
      if (depth === 0) break;
      depth--; j++; continue;
    }
    if (c === 32 || c === 9 || c === 10 || c === 13 || c < 32) break;
    j++;
  }
  return { dest: text.slice(i, j), next: j };
}

// Link title at i. Returns {title, next} or null.
function parseLinkTitle(text, i) {
  const n = text.length;
  if (i >= n) return null;
  const q = text.charCodeAt(i);
  if (q === 34 || q === 39) {
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === q) return { title: text.slice(i + 1, j), next: j + 1 };
      j++;
    }
    return null;
  }
  if (q === 40) {
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if (c === 92) { j += 2; continue; }
      if (c === 40) return null;
      if (c === 41) return { title: text.slice(i + 1, j), next: j + 1 };
      j++;
    }
    return null;
  }
  return null;
}

// Build the href for a link destination: resolve escapes, percent-encode
// spaces (marked encodes ' ' as %20 in <...> destinations).
// Percent-encode a URL the way marked's cleanUrl does: encodeURI, then
// un-double-encode '%' (%25 -> %). encodeURI throws on lone surrogates.
function encodeHref(s) {
  try {
    return encodeURI(s).replace(/%25/g, '%');
  } catch {
    return s;
  }
}

function buildHref(dest) {
  // marked's cleanUrl: resolve escapes, then encodeHref.
  return encodeHref(resolveEscapes(dest));
}

// Escape for href/title attribute values: like escapeText, but a '&' that
// starts a valid entity reference (&name;, &#dec;, &#xhex;) is left alone
// (marked's escapeTestNoEncode).
function escapeNoEncodeText(out, s, start, end) {
  let i = start;
  let chunk = start;
  for (; i < end; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) {
      if (!isEntityRef(s, i, end)) rep = '&amp;';
    } else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (i > chunk) out.push(s.slice(chunk, i));
      out.push(rep);
      chunk = i + 1;
    }
  }
  if (end > chunk) out.push(s.slice(chunk, end));
}

// s[i] === '&': true when the text at i is a valid entity reference
// (&#<1-7 dec>; / &#[xX]<1-6 hex>; / &<alnum>+;) that must be preserved.
function isEntityRef(s, i, end) {
  let j = i + 1;
  if (j >= end) return false;
  if (s.charCodeAt(j) === 35) {
    j++;
    let hex = false;
    if (j < end && (s.charCodeAt(j) === 120 || s.charCodeAt(j) === 88)) { hex = true; j++; }
    const ds = j;
    let digits = 0;
    while (j < end) {
      const c = s.charCodeAt(j);
      if (c >= 48 && c <= 57) { j++; digits++; continue; }
      if (hex && ((c >= 97 && c <= 102) || (c >= 65 && c <= 70))) { j++; digits++; continue; }
      break;
    }
    if (digits === 0) return false;
    if (hex && digits > 6) return false;
    if (!hex && digits > 7) return false;
    return j < end && s.charCodeAt(j) === 59;
  }
  if ((s.charCodeAt(j) >= 65 && s.charCodeAt(j) <= 90) || (s.charCodeAt(j) >= 97 && s.charCodeAt(j) <= 122)) {
    while (j < end) {
      const c = s.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) j++;
      else break;
    }
    return j < end && s.charCodeAt(j) === 59 && j > i + 1;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Inline parsing — autolinks and raw HTML
// ---------------------------------------------------------------------------

function isEmailLocalChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) ||
    c === 46 || c === 33 || c === 35 || c === 36 || c === 37 || c === 38 || c === 39 ||
    c === 42 || c === 43 || c === 47 || c === 61 || c === 63 || c === 94 || c === 95 ||
    c === 96 || c === 123 || c === 124 || c === 125 || c === 126 || c === 45;
}

// Match an email domain starting at i: labels of [A-Za-z0-9]([A-Za-z0-9-]*
// [A-Za-z0-9])? joined by '.', at least one dot. Returns end index or -1.
// Match an email domain starting at i, per the GFM email regex:
// [A-Za-z0-9-_]+ (?:\.[A-Za-z0-9-_]*[A-Za-z0-9])+ (?![\w-]).
// The first label may start/end with '-' or '_' (b-.com, b_c.com); every
// label after a dot must end with an alphanumeric. A dot not followed by
// such a label ends the domain there (the regex's + just stops).
// `hasUndOpener` (from tryEmail) says a '_' emphasis opener precedes the
// email's local part, so a trailing '_' run may be its closer.
// Returns the end index, or -1 if there is no dot-label.
function matchEmailDomain(text, i, hasUndOpener) {
  const n = text.length;
  const isDom = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 95;
  const isAlnum = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57);
  let j = i;
  while (j < n && isDom(text.charCodeAt(j))) j++;
  if (j === i) return -1;
  let labels = 0;
  while (j < n && text.charCodeAt(j) === 46) {
    let k = j + 1;
    let lastAlnum = -1;
    while (k < n && isDom(text.charCodeAt(k))) {
      if (isAlnum(text.charCodeAt(k))) lastAlnum = k;
      k++;
    }
    if (k === j + 1) break; // empty label after the dot
    if (lastAlnum < 0) break; // label has no alphanumeric at all
    if (!isAlnum(text.charCodeAt(k - 1))) {
      // Label ends with '_' or '-'. A '-' is never a delimiter, so the
      // label is invalid. A trailing '_' run is an emphasis delimiter
      // (marked masks it, so the regex lookahead passes) when the run
      // has length >= 2, or when a '_' opener precedes the email (a
      // lone '_' with no opener is a literal underscore, per the GFM
      // spec examples a.b-c_d@a.b_); what follows the run must not
      // continue the word ('.' + a label char would continue the
      // domain, e.g. com_.x). Backtrack the label to its last
      // alphanumeric and end the domain there.
      if (text.charCodeAt(k - 1) !== 95) break;
      let runStart = k - 1;
      while (runStart > j && text.charCodeAt(runStart - 1) === 95) runStart--;
      if (k - runStart < 2 && !hasUndOpener) break; // lone '_' is literal
      let after = k;
      let isDelim = true;
      if (after < n && text.charCodeAt(after) === 46 && after + 1 < n && isAlnum(text.charCodeAt(after + 1))) isDelim = false;
      if (!isDelim) break;
      labels++;
      j = lastAlnum + 1;
      break; // domain ends at the delimiter
    }
    labels++;
    j = k;
  }
  if (labels === 0) return -1;
  return j;
}

// Try to match an email starting with its local part at [start, at). The
// local part is the maximal run of email-local chars ending just before the
// '@' at position `at`. Returns {href, end} or null. A trailing '_' or '-'
// after the domain invalidates the match (the address would be part of a
// larger word).
function tryEmail(text, start, at) {
  const n = text.length;
  let s = at;
  while (s > start && isEmailLocalChar(text.charCodeAt(s - 1))) {
    // a backslash-escaped char is not part of the local part
    if (s - 2 >= start && text.charCodeAt(s - 2) === 92) {
      let bs = 0, k = s - 2;
      while (k >= start && text.charCodeAt(k) === 92) { bs++; k--; }
      if (bs % 2 === 1) break;
    }
    s--;
  }
  if (s === at) return null;
  // A '_' emphasis opener before the local part means a trailing '_' run
  // after the domain may be its closer (marked masks the delimiters).
  // Plausible opener: a '_' run preceded by a non-alphanumeric (start,
  // whitespace, punctuation) — an intraword '_' (foo_bar) cannot open.
  let hasUndOpener = false;
  for (let p = start; p < s; p++) {
    if (text.charCodeAt(p) === 95) {
      const prev = p === 0 ? -1 : text.charCodeAt(p - 1);
      const isAlnumPrev = (prev >= 65 && prev <= 90) || (prev >= 97 && prev <= 122) || (prev >= 48 && prev <= 57);
      if (!isAlnumPrev) { hasUndOpener = true; break; }
      while (p < s && text.charCodeAt(p) === 95) p++;
    }
  }
  const domEnd = matchEmailDomain(text, at + 1, hasUndOpener);
  if (domEnd < 0) return null;
  if (domEnd < n) {
    const nc = text.charCodeAt(domEnd);
    // A trailing '-' invalidates (regex (?![\w-])). A trailing '_' run
    // is fine when it is an emphasis delimiter (matchEmailDomain already
    // backtracked past it); it only invalidates when '.' + a label char
    // follows it, i.e. the domain would continue (com_.x).
    if (nc === 45) return null;
    if (nc === 95) {
      let q = domEnd;
      while (q < n && text.charCodeAt(q) === 95) q++;
      // a lone '_' is a literal underscore unless an opener precedes
      if (q - domEnd < 2 && !hasUndOpener) return null;
      if (q < n && text.charCodeAt(q) === 46 && q + 1 < n) {
        const d = text.charCodeAt(q + 1);
        if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 45 || d === 95) return null;
      }
    }
  }
  const email = text.slice(s, domEnd);
  return { href: encodeHref('mailto:' + email), display: email, start: s, end: domEnd };
}

// Strip trailing punctuation from a URL candidate per the GFM autolink
// rules: trailing ? ! . , : ; * _ ~ ' " ; an unmatched final ')' ; a
// trailing &name; entity-like suffix.
// Strip a URL tail per marked's _backpedal, over s[start..end).
// Returns the trimmed absolute end index (no allocation).
function stripUrlTail(s, start, end) {
  let e = end;
  // marked's _backpedal: a '(' with no matching ')' after it ends the
  // URL (the \([^)]*\) group fails there, so the match stops at '(')
  let i = start;
  while (i < e) {
    if (s.charCodeAt(i) === 40) {
      const close = s.indexOf(')', i + 1);
      if (close === -1 || close >= e) { e = i; break; }
      i = close + 1;
    } else i++;
  }
  // trailing &name; entity-like suffix
  if (e > start && s.charCodeAt(e - 1) === 59) {
    let k = e - 2;
    while (k >= start) {
      const c = s.charCodeAt(k);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k--;
      else break;
    }
    if (k >= start && s.charCodeAt(k) === 38 && e - 2 - k >= 1) e = k;
  }
  let changed = true;
  while (changed) {
    changed = false;
    while (e > start) {
      const c = s.charCodeAt(e - 1);
      if (c === 63 || c === 33 || c === 46 || c === 44 || c === 58 || c === 59 ||
          c === 42 || c === 95 || c === 126 || c === 39 || c === 34) { e--; changed = true; }
      else break;
    }
    if (e > start && s.charCodeAt(e - 1) === 41) {
      // A trailing ')' is kept only if it closes a '(' group, where
      // a group runs from '(' to the FIRST ')' after it: inner '('
      // are content, not nested groups (marked's _backpedal
      // \([^)]*\)). So 'a(b(c))' keeps '(b(c)' and strips the final
      // ')', while 'server)](https://img.../page=6)' keeps its final
      // ')' because it closes the '(' before 'https://img'. An
      // unmatched ')' in the middle neither opens nor closes a group.
      let inGroup = false;
      for (let p = start; p < e - 1; p++) {
        const c = s.charCodeAt(p);
        if (c === 40) { if (!inGroup) inGroup = true; }
        else if (c === 41) { if (inGroup) inGroup = false; }
      }
      if (!inGroup) { e--; changed = true; }
    }
  }
  return e;
}

// Validate a domain: labels of [A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?
// joined by '.', at least one label, none starting/ending with '-'.
function validDomain(s, start, end) {
  if (start >= end) return false;
  // marked's domain is (?:[a-zA-Z0-9-]+\.?)+ followed by [^\s<]* for the
  // rest, so it only needs a valid FIRST label — the remainder (including
  // '..' or a trailing '.') is absorbed as path. A domain ending in '.'
  // (https://img.shields.io.\) or with '..' (https://example..com/) is
  // therefore valid; only the first label is checked strictly.
  let i = start;
  while (i < end) {
    const c = s.charCodeAt(i);
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) break;
    i++;
  }
  if (i === start) return false; // empty first label
  if (s.charCodeAt(start) === 45 || s.charCodeAt(i - 1) === 45) return false;
  return true;
}

// Try a www. / scheme:// extended autolink starting at i. `prev` is the
// char code before i (-1 at start). `limit` bounds the scan (used inside
// link brackets so the URL cannot swallow the ']' that closes the link).
// Returns {href, display, end} or null.
function tryExtUrl(text, i, prev, limit) {
  const n = text.length;
  const lim = limit === undefined ? n : limit;
  const okPrev = prev === -1 || isWhitespace(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40 || prev === 91 || prev === 60;
  if (!okPrev) return null;
  // www.
  if (text.charCodeAt(i) === 119 && text.startsWith('www.', i)) {
    let j = i + 4;
    while (j < lim) {
      const c = text.charCodeAt(j);
      if (isWhitespace(c) || c === 60 || c < 32) break;
      j++;
    }
    const uEnd = stripUrlTail(text, i, j);
    const cand = text.slice(i, uEnd);
    if (cand.length <= 4) return null;
    // the domain ends at the first character that cannot be in a
    // domain (a '/', '?', '#', port ':', or a path character like ')'
    // or ']' all end it); the rest is path/query/fragment
    let dEnd = cand.length;
    for (let k = 4; k < cand.length; k++) {
      const c = cand.charCodeAt(k);
      if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46)) { dEnd = k; break; }
    }
    if (!validDomain(cand, 4, dEnd)) return null;
    return { href: encodeHref('http://' + cand), display: cand, end: uEnd };
  }
  // scheme://
  if ((text.charCodeAt(i) >= 65 && text.charCodeAt(i) <= 90) || (text.charCodeAt(i) >= 97 && text.charCodeAt(i) <= 122)) {
    let j = i + 1;
    while (j < n) {
      const c = text.charCodeAt(j);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46) j++;
      else break;
    }
    const schemeLen = j - i;
    if (schemeLen >= 2 && schemeLen <= 32 && text.startsWith('://', j)) {
      let k = j + 3;
      while (k < lim) {
        const c = text.charCodeAt(k);
        if (isWhitespace(c) || c === 60 || c < 32) break;
        k++;
      }
      const uEnd = stripUrlTail(text, i, k);
      const cand = text.slice(i, uEnd);
      const domStart = (j + 3) - i; // index into cand, not into text
      let dEnd = cand.length;
      for (let p = domStart; p < cand.length; p++) {
        const c = cand.charCodeAt(p);
        if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45 || c === 46)) { dEnd = p; break; }
      }
      if (!validDomain(cand, domStart, dEnd)) return null;
      return { href: encodeHref(cand), display: cand, end: uEnd };
    }
    // mailto: / xmpp: + email
    if (text.startsWith('mailto:', i) || text.startsWith('xmpp:', i)) {
      const after = i + (text.charCodeAt(i) === 109 ? 7 : 5);
      // email local part starts at `after`
      let a = after;
      while (a < n && isEmailLocalChar(text.charCodeAt(a))) a++;
      if (a > after && a < n && text.charCodeAt(a) === 64) {
        const domEnd = matchEmailDomain(text, a + 1);
        if (domEnd > 0) {
          // a trailing '_' or '-' after the domain invalidates the match
          if (domEnd < n) {
            const nc = text.charCodeAt(domEnd);
            if (nc === 95 || nc === 45) return null;
          }
          let end = domEnd;
          if (text.charCodeAt(i) === 120) {
            // xmpp: optional /resource of [A-Za-z0-9@.]+
            if (end < n && text.charCodeAt(end) === 47) {
              let r = end + 1;
              while (r < n) {
                const c = text.charCodeAt(r);
                if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 64 || c === 46) r++;
                else break;
              }
              if (r > end + 1) end = r;
            }
          }
          const link = text.slice(i, end);
          return { href: encodeHref(link), display: link, end };
        }
      }
    }
  }
  return null;
}

// Parse a raw HTML tag starting at i (text[i] === '<', not a comment/PI/
// declaration/CDATA). Returns the end index (exclusive) or -1.
function parseHtmlTag(text, i) {
  const n = text.length;
  let j = i + 1;
  let closing = false;
  if (j < n && text.charCodeAt(j) === 47) { closing = true; j++; }
  if (j >= n) return -1;
  const c0 = text.charCodeAt(j);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  while (j < n) {
    const c = text.charCodeAt(j);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45) j++;
    else break;
  }
  // A closing tag takes no attributes and no '/': only whitespace then '>'.
  if (closing) {
    while (j < n && isWhitespace(text.charCodeAt(j))) j++;
    if (j < n && text.charCodeAt(j) === 62) return j + 1;
    return -1;
  }
  while (j < n) {
    // skip whitespace; every attribute needs whitespace before it
    let ws = 0;
    while (j < n && isWhitespace(text.charCodeAt(j))) { j++; ws++; }
    if (j >= n) return -1;
    const c = text.charCodeAt(j);
    if (c === 62) return j + 1;
    // self-closing '/' must be immediately followed by '>'
    if (c === 47 && j + 1 < n && text.charCodeAt(j + 1) === 62) return j + 2;
    if (c === 47) return -1;
    if (ws === 0) return -1;
    // attribute name
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c === 58)) return -1;
    while (j < n) {
      const d = text.charCodeAt(j);
      if ((d >= 65 && d <= 90) || (d >= 97 && d <= 122) || (d >= 48 && d <= 57) || d === 95 || d === 58 || d === 46 || d === 45) j++;
      else break;
    }
    // whitespace before '=': only consume it if '=' follows, else it is
    // the separator to the next attribute and the loop top counts it
    const afterName = j;
    while (j < n && isWhitespace(text.charCodeAt(j))) j++;
    if (j < n && text.charCodeAt(j) === 61) {
      j++;
      while (j < n && isWhitespace(text.charCodeAt(j))) j++;
      if (j >= n) return -1;
      const q = text.charCodeAt(j);
      if (q === 34 || q === 39) {
        j++;
        while (j < n && text.charCodeAt(j) !== q) j++;
        if (j >= n) return -1;
        j++;
      } else {
        let got = false;
        while (j < n) {
          const d = text.charCodeAt(j);
          if (isWhitespace(d) || d === 34 || d === 39 || d === 61 || d === 60 || d === 62 || d === 96) break;
          got = true;
          j++;
        }
        if (!got) return -1;
      }
    } else {
      j = afterName;
    }
  }
  return -1;
}

// Try <...> at i: comment / PI / declaration / CDATA / tag / autolink.
// Returns {kind: 'html'|'link', s, end, href?, display?} or null.
function tryAngle(text, i) {
  const n = text.length;
  if (text.startsWith('<!--', i)) {
    // Abrupt close: <!--> and <!---> are complete empty comments.
    if (text.charCodeAt(i + 4) === 62) return { kind: 'html', s: text.slice(i, i + 5), end: i + 5 };
    if (text.charCodeAt(i + 4) === 45 && text.charCodeAt(i + 5) === 62) return { kind: 'html', s: text.slice(i, i + 6), end: i + 6 };
    const e = text.indexOf('-->', i + 4);
    if (e >= 0) return { kind: 'html', s: text.slice(i, e + 3), end: e + 3 };
    return null;
  }
  if (text.startsWith('<?', i)) {
    const e = text.indexOf('?>', i + 2);
    if (e >= 0) return { kind: 'html', s: text.slice(i, e + 2), end: e + 2 };
    return null;
  }
  if (text.startsWith('<![CDATA[', i)) {
    const e = text.indexOf(']]>', i + 9);
    if (e >= 0) return { kind: 'html', s: text.slice(i, e + 3), end: e + 3 };
    return null;
  }
  if (text.startsWith('<!', i) && i + 2 < n) {
    const c = text.charCodeAt(i + 2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      const e = text.indexOf('>', i + 2);
      if (e >= 0) return { kind: 'html', s: text.slice(i, e + 1), end: e + 1 };
    }
    return null;
  }
  const tagEnd = parseHtmlTag(text, i);
  if (tagEnd > 0) return { kind: 'html', s: text.slice(i, tagEnd), end: tagEnd };
  // autolink: <scheme:...> or <email>
  const e = text.indexOf('>', i + 1);
  if (e < 0 || e === i + 1) return null;
  const inner = text.slice(i + 1, e);
  for (let k = 0; k < inner.length; k++) {
    const c = inner.charCodeAt(k);
    if (c === 32 || c === 9 || c === 10 || c === 60 || c < 32) return null;
  }
  const colon = inner.indexOf(':');
  if (colon > 0) {
    const scheme = inner.slice(0, colon);
    if (/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}$/.test(scheme)) {
      return { kind: 'link', href: encodeHref(inner), display: inner, end: e + 1 };
    }
  }
  // email: local@domain
  const at = inner.indexOf('@');
  if (at > 0) {
    let ok = true;
    for (let k = 0; k < at; k++) if (!isEmailLocalChar(inner.charCodeAt(k))) { ok = false; break; }
    if (ok) {
      const domEnd = matchEmailDomain(inner, at + 1);
      if (domEnd === inner.length) {
        return { kind: 'link', href: encodeHref('mailto:' + inner), display: inner, end: e + 1 };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline parsing — scanner, emphasis, emit
// ---------------------------------------------------------------------------

const P_TEXT = 0, P_DELIM = 1, P_CODE = 2, P_LINK = 3, P_AUTOLINK = 4, P_HTML = 5, P_BR = 6, P_BRACKET = 7;

// Document-level inLink state (marked's Lexer.state.inLink): set by an
// inline <a ...> start tag, cleared by </a>, and NOT reset between blocks
// (only inRawBlock is reset per block in marked's lex()). While set, the
// GFM extended autolink (www/scheme/email) is disabled; angle-bracket
// autolinks are unaffected. Reset at the start of parse().
let docInLink = false;

// Scan `text` into parts. `refs` maps normalized labels to {dest, title}.
// Delimiter parts (emphasis + brackets) are collected in `stack` in order.
function scanInline(text, refs, parts, stack) {
  const n = text.length;
  let i = 0;
  let textStart = 0;
  // Start positions of unmatched '~' openers seen so far in this inline
  // text (a strikethrough span in progress). A '*'/'_' delimiter next
  // to a '~' run that is the boundary of the ENCLOSING del span is at
  // the edge of that del's inner text — marked re-tokenizes the inner
  // text on its own, so the '~' reads as a string boundary there, not
  // as a neighbouring character (e.g. the '**' closer in
  // '~~used **new remove `utf-8()`**~~' sees end-of-text, not '~').
  // The top of the stack is the enclosing span; a '~' run is a
  // boundary only when it IS that span's opener (prev side) or closes
  // it (next side) — a nested del's closer is not a boundary for a
  // delimiter outside it.
  const tildeStack = [];
  const tildeLen = (p) => (text.charCodeAt(p + 1) === 126 ? 2 : 1);
  // marked's Lexer.state.inRawBlock, reset per inline text (per block):
  // an inline <pre|code|kbd|script> start tag makes the following
  // plain text raw (verbatim, unescaped) until the matching end tag.
  // Emphasis, links, code spans and backslash escapes still work
  // inside it; only text escaping (and entity decoding) is suspended
  // (fresh inst0 doc-19: '`<code> && x < 1`' leaves '&&' and '<' raw).
  let inRaw = false;
  const flushText = (end) => {
    if (end > textStart) parts.push({ k: P_TEXT, s: textStart, e: end, raw: inRaw });
  };

  while (i < n) {
    const c = text.charCodeAt(i);

    // backslash escape / hard break
    if (c === 92) {
      if (i + 1 < n) {
        const d = text.charCodeAt(i + 1);
        if (d === 10) {
          flushText(i);
          parts.push({ k: P_BR });
          i += 2;
          // leading spaces of the next line are stripped after a hard break
          while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
          textStart = i;
          continue;
        }
        if (PUNCT[d] === 1) {
          flushText(i);
          // esc: this char came from a backslash escape; linkTextOf
          // re-adds the backslash so label matching uses the raw label
          // (a label 'foo\!' must not match a ref 'foo!').
          parts.push({ k: P_TEXT, s: i + 1, e: i + 2, esc: true, raw: inRaw });
          i += 2;
          textStart = i;
          continue;
        }
      }
      i++;
      continue;
    }

    // code span
    if (c === 96) {
      let m = 1;
      while (i + m < n && text.charCodeAt(i + m) === 96) m++;
      // find a closing run of exactly m backticks. A code span must not
      // cross the ']' that closes an enclosing link label WHEN the link
      // actually forms (marked matches the link first): e.g. [values
      // ``guide` in](#should) — the lone '`' after guide must not
      // swallow the ']' and reach a backtick much later; the link forms
      // instead. But when the link does NOT form (bad dest, or the ref
      // doesn't resolve) the code span wins and DOES cross the ']'
      // (cm-342: [not a `link](/foo`) renders the code span, no link;
      // [lexer path ``project`][empty-3] forms the giant code span
      // because the ref doesn't resolve). So at a ']' followed by '('
      // or '[', stop only if linkWouldForm says the link forms.
      let j = i + m;
      let close = -1;
      while (j < n) {
        const jc = text.charCodeAt(j);
        if (jc === 93) {
          const after = j + 1;
          if (after < n && (text.charCodeAt(after) === 40 || text.charCodeAt(after) === 91)) {
            let bPos = -1;
            for (let s = stack.length - 1; s >= 0; s--) {
              const p = parts[stack[s]];
              if (p.k === P_BRACKET && p.active) { bPos = p.s; break; }
            }
            if (bPos >= 0 && linkWouldForm(text, bPos, j, refs)) break;
          }
        }
        if (jc === 96) {
          let r = 1;
          while (j + r < n && text.charCodeAt(j + r) === 96) r++;
          if (r === m) { close = j; break; }
          j += r;
        } else j++;
      }
      if (close < 0) { i += m; continue; }
      let content = text.slice(i + m, close);
      content = content.replace(/\n/g, ' ');
      if (content.length >= 2 && content.charCodeAt(0) === 32 && content.charCodeAt(content.length - 1) === 32 && content.trim() !== '') {
        content = content.slice(1, -1);
      }
      flushText(i);
      // `src` is the exact source text (backticks included); `raw` is the
      // processed content. linkTextOf needs the source for label matching.
      // `s`/`e` are the source span, used by the emphasis mask to tell a
      // real code span from a phantom pairing.
      parts.push({ k: P_CODE, html: escapeStr(content), raw: content, src: text.slice(i, close + m), s: i, e: close + m });
      i = close + m;
      textStart = i;
      continue;
    }

    // emphasis / strikethrough delimiter run
    if (c === 42 || c === 95 || c === 126) {
      let m = 1;
      while (i + m < n && text.charCodeAt(i + m) === c) m++;
      if (c === 126 && m > 2) { i += m; continue; }
      const rawPrev = i > 0 ? text.charCodeAt(i - 1) : -1;
      const rawNext = i + m < n ? text.charCodeAt(i + m) : -1;
      // oOpen/oClose drive the intermediate-run accounting in
      // emphasisCanMatch (growth/reduction/rule-of-3): they see the run
      // as marked's outer scan does, with the '~' neighbour present.
      // canOpen/canClose drive the run's own matching: a run at the edge
      // of a del span's inner text sees the del boundary as a string
      // boundary there (marked re-tokenizes the inner text on its own).
      const oLeft = isLeftFlankingEm(rawPrev, rawNext);
      const oRight = isRightFlankingEm(rawPrev, rawNext);
      let prev = rawPrev, next = rawNext;
      if (c !== 126) {
        // A '~' neighbour that is the boundary of the enclosing del span
        // reads as a string boundary (see tildeStack above).
        if (prev === 126) {
          let L = 0, q = i - 1;
          while (q >= 0 && text.charCodeAt(q) === 126) { L++; q--; }
          // the '~' run ending here is the enclosing span's opener only
          // when it is the top of the stack (its start position matches)
          if ((L === 1 || L === 2) && tildeStack.length > 0 && tildeStack[tildeStack.length - 1] === i - L) prev = -1;
        }
        if (next === 126) {
          let L = 0, q = i + m;
          while (q < n && text.charCodeAt(q) === 126) { L++; q++; }
          // the '~' run starting here closes the enclosing span only
          // when the top of the stack has the same length
          if ((L === 1 || L === 2) && tildeStack.length > 0 && tildeLen(tildeStack[tildeStack.length - 1]) === L) {
            const nC = q < n ? text.charCodeAt(q) : -1;
            if (isRightFlankingEm(c, nC)) next = -1;
          }
        }
      }
      const left = isLeftFlankingEm(prev, next);
      const right = isRightFlankingEm(prev, next);
      let canOpen, canClose, oOpen, oClose;
      if (c === 95) {
        // The flanking itself is GFM (Em: '~' is not punctuation), but
        // the '_' intraword exceptions test standard punctuation: a '_'
        // followed by '~' CAN close (marked renders <em>a</em> in
        // 'x _a_~y'), while one followed by a letter cannot.
        canOpen = left && (!right || isPunct(prev));
        canClose = right && (!left || isPunct(next));
        oOpen = oLeft && (!oRight || isPunct(rawPrev));
        oClose = oRight && (!oLeft || isPunct(rawNext));
      } else {
        canOpen = left;
        canClose = right;
        oOpen = oLeft;
        oClose = oRight;
      }
      flushText(i);
      const part = { k: P_DELIM, ch: c, n: m, s: i, canOpen, canClose, oOpen, oClose, opens: null, closes: null, usedOpen: 0, usedClose: 0 };
      parts.push(part);
      stack.push(parts.length - 1);
      if (c === 126) {
        if (canClose) {
          // find the topmost pending opener of the same length
          let ix = -1;
          for (let s = tildeStack.length - 1; s >= 0; s--) {
            if (tildeLen(tildeStack[s]) === m) { ix = s; break; }
          }
          if (ix >= 0) tildeStack.splice(ix, 1);
          else if (canOpen) tildeStack.push(i);
        } else if (canOpen) tildeStack.push(i);
      }
      i += m;
      textStart = i;
      continue;
    }

    // image / link bracket
    if (c === 91 || (c === 33 && i + 1 < n && text.charCodeAt(i + 1) === 91)) {
      const img = c === 33;
      flushText(i);
      // `s` is the source position of the '[' (needed to test whether a
      // code span may cross this label's closing ']' — see code spans)
      const part = { k: P_BRACKET, img, active: true, s: img ? i + 1 : i };
      parts.push(part);
      stack.push(parts.length - 1);
      i += img ? 2 : 1;
      textStart = i;
      continue;
    }

    // closing bracket: try to form a link
    if (c === 93) {
      // flush the pending text first so tryLink sees it as link children
      flushText(i);
      textStart = i; // the ']' itself is not yet consumed
      const link = tryLink(text, i, refs, parts, stack);
      if (link) {
        i = link.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // < : raw HTML or autolink
    if (c === 60) {
      const a = tryAngle(text, i);
      if (a) {
        flushText(i);
        if (a.kind === 'html') {
          // marked's tag tokenizer: <a<space> sets inLink, </a> clears it
          // (case-insensitive; '<a>' with no space does NOT set it).
          const s0 = a.s;
          if (s0.length >= 3 && (s0.charCodeAt(1) === 97 || s0.charCodeAt(1) === 65) && s0.charCodeAt(2) === 32) docInLink = true;
          else if (s0.length === 4 && s0.charCodeAt(1) === 47 && (s0.charCodeAt(2) === 97 || s0.charCodeAt(2) === 65) && s0.charCodeAt(3) === 62) docInLink = false;
          // inRawBlock: a <pre|code|kbd|script> start tag (attributes
          // allowed, case-insensitive; '<code/>' does not count) turns
          // raw text on; the matching end tag turns it off. A start
          // tag while already raw leaves it on (nested tags).
          if (!inRaw && /^<(pre|code|kbd|script)(\s|>)/i.test(s0)) inRaw = true;
          else if (inRaw && /^<\/(pre|code|kbd|script)(\s|>)/i.test(s0)) inRaw = false;
          parts.push({ k: P_HTML, s: a.s });
        }
        else parts.push({ k: P_AUTOLINK, href: a.href, display: a.display });
        i = a.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // & : entity. Named entities pass through as raw HTML (the reference
    // itself, e.g. &copy;); numeric entities decode to one character,
    // which is then escaped on emission like any other text. Inside a
    // raw block (inRaw) entities are NOT decoded at all — the '&' stays
    // ordinary text and the part is emitted verbatim (fresh doc-19).
    if (c === 38 && !inRaw) {
      const ent = entityAt(text, i, n);
      if (ent) {
        flushText(i);
        if (ent[0].length > 1 && ent[0].charCodeAt(0) === 38) {
          parts.push({ k: P_HTML, s: ent[0] });
        } else {
          parts.push({ k: P_TEXT, s: -1, e: -1, lit: ent[0] });
        }
        i += ent[1];
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // newline: hard break when preceded by 2+ spaces
    if (c === 10) {
      let sp = 0;
      let k = i - 1;
      while (k >= textStart && text.charCodeAt(k) === 32) { sp++; k--; }
      if (sp >= 2) {
        flushText(i - sp);
        parts.push({ k: P_BR });
        i++;
        // leading spaces of the next line are stripped after a hard break
        while (i < n && (text.charCodeAt(i) === 32 || text.charCodeAt(i) === 9)) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // email autolink: on '@', look back for a local part. The local part
    // may extend into already-emitted parts (e.g. past a '_' delimiter),
    // so scan back through the raw text and unwind those parts.
    // Disabled while docInLink (marked gates url on !state.inLink).
    if (c === 64 && !docInLink) {
      const em = tryEmail(text, 0, i);
      if (em) {
        if (em.start < textStart) {
          // unwind parts overlapping [em.start, textStart): drop delimiter
          // parts inside the range, truncate or drop text parts
          while (parts.length > 0) {
            const p = parts[parts.length - 1];
            if (p.k === P_DELIM) {
              if (p.s >= em.start) { parts.pop(); continue; }
              if (p.s + p.n > em.start) { p.n = em.start - p.s; }
              break;
            }
            if (p.k === P_TEXT) {
              if (p.e <= em.start) break;
              if (p.s >= em.start) { parts.pop(); continue; }
              p.e = em.start;
              break;
            }
            break;
          }
        }
        flushText(em.start);
        parts.push({ k: P_AUTOLINK, href: em.href, display: em.display, ext: true });
        i = em.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // www. / scheme extended autolink
    if (c === 119 || ((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) {
      const prev = i > 0 ? text.charCodeAt(i - 1) : -1;
      // only attempt when at a plausible start (prev char is a boundary or
      // the char before is not a letter/digit that would extend the word)
      if (prev === -1 || isWhitespace(prev) || prev === 42 || prev === 95 || prev === 126 || prev === 40 || prev === 91 || prev === 60) {
        // Disabled while docInLink (marked gates url on !state.inLink).
        if (!docInLink) {
        // Inside link brackets, an autolink must not swallow the ']'
        // that closes the link text (marked matches the link first, so
        // the ']' belongs to the link, not the URL). Bound the scan at
        // the next ']' ONLY when it really is a link closer: followed
        // by '(' (inline dest), and the bracket can form a link (an
        // image, or children with no nested link — otherwise tryLink
        // rejects the ']' and it is literal text the URL may include).
        let limit = n;
        // number of active brackets: a ']' that closes the innermost
        // bracket still matters when an outer bracket is waiting (it
        // lets the outer bracket match a later ']'), even if the
        // closer itself cannot form a link.
        let activeBrackets = 0;
        for (let s = 0; s < stack.length; s++) {
          const bp = parts[stack[s]];
          if (bp.k === P_BRACKET && bp.active) activeBrackets++;
        }
        for (let s = stack.length - 1; s >= 0; s--) {
          const bp = parts[stack[s]];
          if (bp.k === P_BRACKET && bp.active) {
            let canLink = bp.img;
            if (!canLink) {
              canLink = true;
              for (let p = stack[s] + 1; p < parts.length; p++) {
                if (parts[p].k === P_LINK && !parts[p].img) { canLink = false; break; }
              }
            }
            if (canLink) {
              for (let q = i; q < n; q++) {
                // With an outer bracket waiting, ANY unescaped ']' closes
                // the innermost bracket (even followed by plain text —
                // the bracket just becomes literal, deactivating it so
                // the outer bracket can match a later ']'); the URL must
                // stop there. Without an outer bracket, only a ']' that
                // can itself form a link (followed by '(' or a defined
                // ref '[') bounds the URL.
                const isClose = text.charCodeAt(q) === 93 && (q === 0 || text.charCodeAt(q - 1) !== 92);
                if (isClose && (activeBrackets >= 2 || (q + 1 < n && (text.charCodeAt(q + 1) === 40 || text.charCodeAt(q + 1) === 91)))) {
                  // For '][' the ']' is only a real link closer when the
                  // following ref label is defined; an undefined ref
                  // (e.g. '[test render www.tiny.com][library issues]')
                  // leaves the ']' literal, so the URL may include it —
                  // UNLESS an outer bracket is waiting: the ']' still
                  // closes this bracket (deactivating it), which lets
                  // the outer bracket match a later ']' and form its
                  // link (inst0 doc-22: '[outer [a https://...][14]
                  // text](#dest)' — the '[14]' is undefined, but the
                  // ']' after the URL must not be swallowed, or the
                  // inner bracket steals the '](#dest)').
                  if (text.charCodeAt(q + 1) === 91) {
                    let r = q + 2;
                    while (r < n && text.charCodeAt(r) !== 93) r++;
                    const refLab = text.slice(q + 2, r);
                    const key = refLab === '' ? null : normalizeLabel(refLab);
                    // collapsed '[]' uses the label itself; check it via
                    // the bracket's own label text is complex, so treat
                    // '[]' as a real closer (it usually is one)
                    if (key !== null && !refs.has(key) && activeBrackets < 2) continue;
                  }
                  limit = q; break;
                }
              }
            }
            break;
          }
        }
        // A pending emphasis/strikethrough opener before this URL claims
        // a later delimiter run as its closer before the autolink can
        // swallow it: marked's emStrong/del tokenizers fire at the
        // opener, which precedes the URL, so the URL ends where its
        // closer begins (e.g. `~~a **b http://x**~~` — the URL is
        // `http://x`, not `http://x**~~`). Without this, a trailing
        // backslash after the closer (`**~~.)\`) defeats stripUrlTail
        // (the `\` is not trailing punctuation), the URL swallows the
        // closers, and the emphasis never matches. Only delimiters in
        // the current span count: those after the last still-open
        // bracket (a label's own delimiters); a resolved link's
        // children are already out of `parts`.
        let urlLimit = limit;
        {
          let openerInfo = null;
          const getOpeners = () => {
            if (openerInfo) return openerInfo;
            let openChars = 0, tildeLens = 0, spanStart = 0;
            for (let p = parts.length - 1; p >= 0; p--) {
              if (parts[p].k === P_BRACKET && parts[p].active) { spanStart = p + 1; break; }
            }
            for (let p = spanStart; p < parts.length; p++) {
              const d = parts[p];
              if (d.k === P_DELIM && d.canOpen) {
                if (d.ch === 42) openChars |= 1;
                else if (d.ch === 95) openChars |= 2;
                else if (d.ch === 126) { openChars |= 4; tildeLens |= d.n === 1 ? 1 : d.n === 2 ? 2 : 0; }
              }
            }
            openerInfo = [openChars, tildeLens];
            return openerInfo;
          };
          let q = i;
          while (q < limit) {
            const cc = text.charCodeAt(q);
            if (cc === 32 || cc === 9 || cc === 10 || cc === 13 || cc === 60 || cc < 32) break;
            if (cc === 42 || cc === 95 || cc === 126) {
              const bit = cc === 42 ? 1 : cc === 95 ? 2 : 4;
              const oi = getOpeners();
              if (oi[0] & bit) {
                let r = q, m = 0;
                while (r < limit && text.charCodeAt(r) === cc) { r++; m++; }
                const pC = q > 0 ? text.charCodeAt(q - 1) : -1;
                const nC = r < n ? text.charCodeAt(r) : -1;
                const lf = isLeftFlankingEm(pC, nC), rf = isRightFlankingEm(pC, nC);
                const canClose = cc === 95 ? rf && (!lf || isPunct(nC)) : rf;
                if (canClose && (cc !== 126 || (m <= 2 && (oi[1] & (m === 1 ? 1 : 2))))) { urlLimit = q; break; }
                q = r;
              } else q++;
            } else q++;
          }
        }
        const u = tryExtUrl(text, i, prev, urlLimit);
        if (u) {
          flushText(i);
          parts.push({ k: P_AUTOLINK, href: u.href, display: u.display, ext: true });
          i = u.end;
          textStart = i;
          continue;
        }
        } // !docInLink
      }
      i++;
      continue;
    }

    i++;
  }
  flushText(n);
}

// marked disables the GFM extended autolink (bare www/scheme/email)
// inside link text and image alt text (its inLink state): undo any
// such autolink the scanner made while the brackets were still open.
// Angle-bracket autolinks (<...>) stay links.
function undoExtAutolinks(children) {
  for (const ch of children) {
    if (ch.k === P_AUTOLINK && ch.ext) {
      ch.k = P_TEXT; ch.s = -1; ch.e = -1; ch.lit = ch.display;
      delete ch.href; delete ch.display; delete ch.ext;
    } else if (ch.k === P_LINK) {
      undoExtAutolinks(ch.children);
    }
  }
}

// Try to form a link at the ']' at position i. Returns {part, end} or null.
// marked's link-label pattern `re` (label regex, with `brackets` = Le
// inlined): a label is a run of nested-bracket groups, escaped chars,
// code spans, trailing backticks before ']', or plain chars (not '[',
// ']', '\', '`'). The code-span alternative `+(?!`)[^`]*?`+(?!`) matches
// the SHORTEST span (opener and closer need not have equal length), so
// a label like `` `` a ` b `` `` fails: after the shortest span `` `` a ` ``
// the remaining `` `` `` before '_' matches no alternative. Validate the
// raw label text (label + ']') against it before forming any link.
const LABEL_RE = /^(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?\]/;

// LABEL_RE is unanchored at the end, so .test() matches a PREFIX: a
// label containing a ']' inside a code span (e.g. a giant code span
// swallowing '][release-56]') matches only up to that inner ']' and
// .test() still returns true, letting tryLink form a link across the
// code span (fresh2 inst4 doc-06, fresh inst2 doc-08, fresh2 inst3
// doc-34: marked leaves '[you ``if` every pull][release-56] ...'
// literal because the label up to the later ']' is not a valid label).
// A label is valid only when the match consumes the WHOLE string.
function labelReFull(s) {
  const m = LABEL_RE.exec(s);
  return m !== null && m[0].length === s.length;
}

function tryLink(text, i, refs, parts, stack) {
  const n = text.length;
  // find the nearest active '[' bracket in the stack (skip brackets
  // deactivated by an earlier failed ']')
  let bIdx = -1;
  for (let s = stack.length - 1; s >= 0; s--) {
    const p = parts[stack[s]];
    if (p.k === P_BRACKET && p.active) { bIdx = stack[s]; break; }
  }
  if (bIdx < 0) return null;
  const bracket = parts[bIdx];
  // children: parts between the bracket and now (they were pushed after it)
  const children = parts.slice(bIdx + 1);
  const after = i + 1;
  // An inline-link candidate is `[...](...)` with a '(' after ']' and a
  // ')' closing it. When such a link FAILS (bad label or bad dest),
  // marked suppresses ALL emphasis inside the label: the delimiters
  // render literal ([x *a* b](not a url) stays literal; [x _a b_]( with
  // no ')' forms the em). A bare [label] or [label][ref] does not
  // suppress. Mark the label's delimiters dead on failure.
  let inlineCandidate = false;
  if (after < n && text.charCodeAt(after) === 40) {
    for (let k = after + 1; k < n; k++) if (text.charCodeAt(k) === 41) { inlineCandidate = true; break; }
  }
  const fail = () => {
    if (inlineCandidate) for (const ch of children) if (ch.k === P_DELIM) ch.dead = true;
    bracket.active = false; return null;
  };
  // the label must match marked's label regex; a failing label (e.g. a
  // code span whose shortest match leaves stray backticks) is not a link
  if (!labelReFull(linkTextOf(children, text) + ']')) return fail();
  // a link's text may not contain another link (images are fine); a
  // failed attempt deactivates this bracket so a later ']' won't retry it.
  // Images may contain links: their alt text is the link's plain text.
  if (!bracket.img) for (const ch of children) if (ch.k === P_LINK && !ch.img) { bracket.active = false; return null; }

  let dest = null, title = null, end = -1;

  if (after < n && text.charCodeAt(after) === 40) {
    // inline link: (dest "title")
    let j = skipInlineWs(text, after + 1);
    const d = parseLinkDest(text, j);
    if (d) {
      j = skipInlineWs(text, d.next);
      if (j < n && text.charCodeAt(j) === 41) {
        dest = d.dest; end = j + 1;
      } else {
        const t = parseLinkTitle(text, j);
        if (t) {
          j = skipInlineWs(text, t.next);
          if (j < n && text.charCodeAt(j) === 41) {
            dest = d.dest; title = t.title; end = j + 1;
          }
        }
      }
    }
    // an inline link that fails to parse falls back to a shortcut
    // reference link ([foo] with a later-defined [foo]: /url)
    if (dest === null) {
      const key = normalizeLabel(linkTextOf(children, text));
      const ref = refs.get(key);
      if (ref) { dest = ref.dest; title = ref.title; end = i + 1; }
    }
  } else if (after < n && text.charCodeAt(after) === 91) {
    // [label] or []
    const lab = parseLinkLabel(text, after);
    if (lab) {
      const key = lab.label === '' ? normalizeLabel(linkTextOf(children, text)) : normalizeLabel(lab.label);
      const ref = refs.get(key);
      if (ref) { dest = ref.dest; title = ref.title; end = lab.next; }
    }
  } else {
    // shortcut reference
    const key = normalizeLabel(linkTextOf(children, text));
    const ref = refs.get(key);
    if (ref) { dest = ref.dest; title = ref.title; end = i + 1; }
  }

  if (dest === null) return fail();
  // GFM extended autolinks are disabled inside link text / alt text
  undoExtAutolinks(children);
  // deactivate brackets between the opener and here
  for (let s = 0; s < stack.length; s++) {
    const p = parts[stack[s]];
    if (p.k === P_BRACKET && stack[s] > bIdx) p.active = false;
  }
  bracket.active = false;
  // remove the children from the top-level parts (they become the link's)
  parts.length = bIdx + 1;
  // the bracket part itself is replaced by the link. `s`/`e` are the
  // source span of the whole link; `labelEnd` is the position of the ']'
  // closing the label — the emphasis mask must not let a phantom code
  // span cross it (a backtick inside the label cannot pair with one
  // outside it, because marked parses the link first).
  const part = { k: P_LINK, href: buildHref(dest), title: title === null ? null : resolveEscapes(title), img: bracket.img, children, s: bracket.s, e: end, labelEnd: i };
  parts[bIdx] = part;
  // drop stack entries at or after bIdx (the bracket is gone; inner
  // delimiters moved into the link's children)
  let w = 0;
  for (let s = 0; s < stack.length; s++) if (stack[s] < bIdx) stack[w++] = stack[s];
  stack.length = w;
  return { part, end };
}

// The raw text of link children, for label matching: text runs as-is,
// escaped chars with their backslash re-added (raw label form), code
// spans as their source text, other parts as their literal characters.
function linkTextOf(children, text) {
  let s = '';
  for (const ch of children) {
    if (ch.k === P_TEXT) {
      if (ch.s >= 0) s += (ch.esc ? '\\' : '') + text.slice(ch.s, ch.e);
      else s += ch.lit;
    } else if (ch.k === P_DELIM) s += String.fromCharCode(ch.ch).repeat(ch.n);
    else if (ch.k === P_BRACKET) s += ch.img ? '![' : '[';
    else if (ch.k === P_CODE) s += ch.src !== undefined ? ch.src : ch.raw;
    else if (ch.k === P_BR) s += '\n';
    else if (ch.k === P_HTML) s += ch.s;
    else if (ch.k === P_AUTOLINK) s += ch.display;
  }
  return s;
}

// Emphasis resolution over a parts array (recurses into link children).
// Can `opener` (a delimiter run) match `closer` (a later delimiter run
// of the same char)? Mirrors marked's emStrong scan: intermediate
// opener-only runs of the same char grow the effective opener length m,
// intermediate both-flanking runs are either skipped by the rule of
// three (growing f) or reduce m, and the closer only matches when it
// covers m. Intermediate runs use their FULL length (in marked's order
// the outer opener is scanned before the inner runs are consumed). A
// closer may match an opener partially when there is no intermediate
// opener growth (e.g. '**' matching '***' to form a strong, leaving '*'
// for an em). A run of '*' inside a '__...__' pair (or '_' inside
// '**...**') is masked: marked's emStrongRDelim regex skips it, so it
// counts for neither growth nor reduction (cm-470).
function emphasisCanMatch(parts, delims, openerPos, closerPos, kUsed, strong, text) {
  const opener = parts[delims[openerPos]];
  const closer = parts[delims[closerPos]];
  if (opener.ch !== closer.ch) return false;
  // Strikethrough: marked's del() uses the same m accounting as emStrong
  // (intermediate opener-only runs grow the effective opener length, so
  // a nested '~~' needs the later closer), but only runs whose length
  // equals the opener's count at all (a '~' never pairs with '~~').
  if (opener.ch === 126) {
    if (opener.n !== closer.n) return false;
    const o = opener.n - opener.usedOpen - opener.usedClose;
    const cn = closer.n - closer.usedOpen - closer.usedClose;
    if (o <= 0 || cn !== o) return false;
    let p = o;
    for (let q = openerPos + 1; q < closerPos; q++) {
      const mid = parts[delims[q]];
      if (mid.ch !== 126) continue;
      const mn = mid.n - mid.usedOpen - mid.usedClose;
      if (mn !== o) continue;
      if (mid.oOpen && !mid.oClose) p += mn;
      else if (mid.oClose) p -= mn;
    }
    p -= cn;
    return p <= 0;
  }
  // kUsed: the opener length actually used (marked retries a failed run
  // one char at a time as the text rule consumes a literal char, so the
  // effective opener may be shorter than the remaining run).
  const k = kUsed !== undefined ? kUsed : opener.n - opener.usedOpen - opener.usedClose;
  if (k <= 0) return false;
  // y is marked's effective opener length: k PLUS the delimiter chars
  // immediately preceding the opener (i-l in emStrong) — for a reduced
  // opener those are the earlier chars of the same run, so y is the
  // FULL remaining run length, not k. o is marked's `o` flag (the char
  // before the opener is the same delimiter): true when part of the run
  // was already used or the opener was reduced. With o set, a
  // both-flanking intermediate run BREAKS the scan (no match at all),
  // it does not merely defer by the rule of three.
  const rem = opener.n - opener.usedOpen - opener.usedClose;
  const y = rem;
  const o = opener.usedOpen + opener.usedClose > 0 || (kUsed !== undefined && kUsed < rem);
  // marked's R flag (emStrong): the rule of 3 also applies to
  // closer-only intermediate runs when R is set — the char before the
  // opener run is non-whitespace AND (the char after the opener run is
  // punctuation, or for '*' the char before it is not punctuation).
  // E.g. '`s`**... *em* response**large**changes': R is set (opener
  // followed by '.'), so the closing '*' of '*em*' is skipped by the
  // rule of 3 (y=2, b=1) and the opener cannot match the first '**'
  // (m stays 1) — it matches the second instead.
  const pCh = opener.s > 0 ? text.charCodeAt(opener.s - 1) : -1;
  const dPunct = opener.s + opener.n < text.length && isPunct(text.charCodeAt(opener.s + opener.n));
  const h = pCh === 42 || pCh === 95 || (pCh >= 0 && isPunct(pCh));
  const R = pCh >= 0 && !isWhitespace(pCh) && (dPunct || (opener.ch === 42 && !h));
  const maskCh = opener.ch === 42 ? 95 : 42;
  const isMasked = (p) => {
    let hasOpen = false, hasClose = false;
    for (let q = openerPos + 1; q < p; q++) {
      const d = parts[delims[q]];
      if (d.ch === maskCh && d.n >= 2 && d.oOpen) hasOpen = true;
    }
    for (let q = p + 1; q < closerPos; q++) {
      const d = parts[delims[q]];
      if (d.ch === maskCh && d.n >= 2 && d.oClose) hasClose = true;
    }
    return hasOpen && hasClose;
  };
  let growth = 0;
  for (let p = openerPos + 1; p < closerPos; p++) {
    const mid = parts[delims[p]];
    if (mid.ch !== opener.ch) continue;
    if (isMasked(p)) continue;
    if (mid.oOpen && !mid.oClose) growth += mid.n;
  }
  // marked's `o` break (see above): with a reduced/preceded opener, a
  // both-flanking intermediate run stops the scan entirely. It must be
  // checked BEFORE the weak early return below, which would otherwise
  // bypass it and let a reduced opener match through a both-flanking
  // run (e.g. '**files project example request*only**' — the '*only'
  // opener is both-flanking, so the '**' opener at k=1 cannot match).
  if (o) {
    for (let p = openerPos + 1; p < closerPos; p++) {
      const mid = parts[delims[p]];
      if (mid.ch !== opener.ch) continue;
      if (isMasked(p)) continue;
      if (mid.oOpen && mid.oClose) return false;
    }
  }
  // Weak match (the early return): when no opener-only run grows the
  // effective opener, the opener may still match a shorter closer.
  // Marked's m accounting forbids this, but the single-pass renderer
  // needs it to emulate marked's recursion — one opener matching two
  // closers renders the nested ems marked produces by re-tokenizing
  // the outer span's text (cm-408 '__foo_ bar_'). It is only used as a
  // fallback: the opener search prefers a strong match (full m
  // accounting) from any opener, so a weak match never steals a closer
  // that a later opener can match strongly (doc-26).
  if (growth === 0 && !strong) return true;
  let m = k + growth;
  for (let p = openerPos + 1; p < closerPos; p++) {
    const mid = parts[delims[p]];
    if (mid.ch !== opener.ch) continue;
    if (isMasked(p)) continue;
    // A run that cannot close (opener-only, or neither — e.g. an
    // intraword '_' — marked's RDelim scan cannot see it) does not
    // reduce m; only a closer-capable run does.
    if (!mid.oClose) continue;
    const b = mid.n; // full length, as in marked's scan order
    const isBoth = mid.oOpen && mid.oClose;
    // On a closer run already shared with an earlier match (an outer
    // em took some of its chars), a fully-used both-flanking run
    // shorter than the opener is spent and reduces m, it is not
    // skipped by the rule of 3. E.g. '*a **b 2*3*4*** c': the outer
    // em takes 1 char of '***', and the '*3*' delimiters (both-
    // flanking, used, b=1 < y=2) reduce m so the '**' opener cannot
    // match the leftover '**' (marked leaves it literal). On a
    // closer's first match the normal rule-of-3 skip still applies
    // (cm-429 '**foo*bar*baz**': the strong's closer '**' is not
    // shared, so the inner '*bar*' runs are skipped and the strong
    // forms).
    const usedUp = mid.usedOpen + mid.usedClose >= mid.n;
    if ((isBoth || R) && !(closer.strictUsed && usedUp && b < y) && y % 3 !== 0 && (y + b) % 3 === 0) continue; // rule of 3: skipped
    m -= b;
    if (m <= 0) return false; // the opener already matched an earlier closer
  }
  m -= closer.n; // full closer length, as in marked's scan order
  return m <= 0;
}

// m/f of a successful opener/closer match, mirroring marked's emStrong
// scan (used only to place the closer's leftover characters). m starts
// at the opener length plus intermediate opener-only growth, is reduced
// by intermediate both-flanking runs (unless the rule of three skips
// them, growing f instead), then reduced by the closer's full length.
function emphasisMF(parts, delims, openerPos, closerPos, kUsed, text) {
  const opener = parts[delims[openerPos]];
  const closer = parts[delims[closerPos]];
  const k = kUsed !== undefined ? kUsed : opener.n - opener.usedOpen - opener.usedClose;
  // y is the full remaining run length (see emphasisCanMatch).
  const y = opener.n - opener.usedOpen - opener.usedClose;
  // marked's R flag (see emphasisCanMatch): the rule of 3 also applies
  // to closer-only intermediate runs when R is set.
  const pCh = opener.s > 0 ? text.charCodeAt(opener.s - 1) : -1;
  const dPunct = opener.s + opener.n < text.length && isPunct(text.charCodeAt(opener.s + opener.n));
  const h = pCh === 42 || pCh === 95 || (pCh >= 0 && isPunct(pCh));
  const R = pCh >= 0 && !isWhitespace(pCh) && (dPunct || (opener.ch === 42 && !h));
  const maskCh = opener.ch === 42 ? 95 : 42;
  const isMasked = (p) => {
    let hasOpen = false, hasClose = false;
    for (let q = openerPos + 1; q < p; q++) {
      const d = parts[delims[q]];
      if (d.ch === maskCh && d.n >= 2 && d.oOpen) hasOpen = true;
    }
    for (let q = p + 1; q < closerPos; q++) {
      const d = parts[delims[q]];
      if (d.ch === maskCh && d.n >= 2 && d.oClose) hasClose = true;
    }
    return hasOpen && hasClose;
  };
  let growth = 0;
  for (let p = openerPos + 1; p < closerPos; p++) {
    const mid = parts[delims[p]];
    if (mid.ch !== opener.ch) continue;
    if (isMasked(p)) continue;
    if (mid.oOpen && !mid.oClose) growth += mid.n;
  }
  let m = k + growth;
  let f = 0;
  for (let p = openerPos + 1; p < closerPos; p++) {
    const mid = parts[delims[p]];
    if (mid.ch !== opener.ch) continue;
    if (isMasked(p)) continue;
    // A run that cannot close does not reduce m (see emphasisCanMatch).
    if (!mid.oClose) continue;
    const b = mid.n;
    const isBoth = mid.oOpen && mid.oClose;
    if ((isBoth || R) && y % 3 !== 0 && (y + b) % 3 === 0) { f += b; continue; }
    m -= b;
  }
  m -= closer.n;
  return { m, f };
}

// marked's emStrong masking (#n): regions of the inline text that are
// invisible to the emphasis scan — inline links, code spans, HTML tags.
// The code-span pairing runs over the whole text first (anyPunctuation-
// OutsideCode), so a mismatched backtick run can pair with a later run
// and swallow a delimiter that sits between them (e.g. doc-09/16/35:
// the `` before `url` pairs with the `` before ` a ` b ``, hiding the
// `_..._` between them from the emphasis scan). Only the intervals are
// needed: a delimiter whose run starts inside one renders literal and
// can neither open nor close, nor grow/reduce a match, nor serve as a
// mask-opener for the other delimiter char.
const MASK_OT_RE = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const MASK_BLOCKSKIP_RE = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)()(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;

// marked's #n reflink masking (reflinkSearch): a '[label][ref]' /
// '[ref]' / '[ref][]' span whose ref is a known link definition is
// invisible to the emphasis scan (inst3 doc-24: the '*' inside
// '[on *removes our removes [3][]* export][5]' stays literal because
// marked masks the whole span). Label (Lt) allows nested brackets,
// escapes and code spans; ref (be) is 1-999 chars with no brackets.
// '@' stands for a backtick (a literal backtick would end the raw
// template literal); it is replaced before compiling.
const REFLINK_LABEL_SRC = String.raw`(?:[^\[\]\\@]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|@+(?!@)[^@]*?@+(?!@)|@@+(?=\]))){0,999}?[^\[\]\\@]*?`.replace(/@/g, String.fromCharCode(96));
const REFLINK_REF_SRC = String.raw`(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}`;
const REFLINK_SEARCH_RE = new RegExp(`!?\\[${REFLINK_LABEL_SRC}\\]\\[${REFLINK_REF_SRC}\\]|!?\\[${REFLINK_REF_SRC}\\](?:\\[\\])?(?!\\()`, 'g');

// Whether a label's text contains a link (marked's linkInText): an
// inline link (a blockSkip match that is a link, not an image), or a
// reference link whose ref is known and whose own label has no link.
function reflinkLabelHasLink(e, refs) {
  if (e.indexOf('[') === -1) return false;
  for (const n of e.matchAll(MASK_BLOCKSKIP_RE)) {
    // inline-link alternative only: it starts with '[' (code spans
    // start with a backtick, tags with '<'); the '!' check excludes
    // images, whose match starts at '[' with '!' just before it.
    if (n[0].charCodeAt(0) === 91 && e.charAt(n.index - 1) !== '!') return true;
  }
  for (const n of e.matchAll(REFLINK_SEARCH_RE)) {
    const s = n[0], r = s.lastIndexOf('[');
    if (!(s.charAt(0) === '!' || !refs.has(normalizeLabel(s.slice(r + 1, -1)))) &&
        !(r > 1 && reflinkLabelHasLink(s.slice(1, r - 1), refs))) return true;
  }
  return false;
}

// Intervals of a text's reflink spans whose ref is a known link
// definition, per marked's #n callback: the whole span is masked,
// except when the label itself contains a link — then only the ref
// is masked and the label is scanned recursively.
function reflinkMaskIntervals(text, refs) {
  const iv = [];
  const scan = (s, base) => {
    for (const m of s.matchAll(REFLINK_SEARCH_RE)) {
      const r = m[0], o = r.lastIndexOf('[');
      if (!refs.has(normalizeLabel(r.slice(o + 1, -1)))) continue;
      const start = base + m.index;
      if (o > 1 && r.charAt(0) !== '!') {
        const label = r.slice(1, o - 1);
        if (reflinkLabelHasLink(label, refs)) {
          scan(label, start + 1);
          iv.push([start + o + 1, start + r.length - 1]);
          continue;
        }
      }
      iv.push([start, start + r.length]);
    }
  };
  scan(text, 0);
  return iv;
}

function applyEmphasisMask(text, parts, refs) {
  // fast path: no emphasis delimiter, or nothing that can mask one
  if (!/[*_~]/.test(text) || !/[`<[]/.test(text)) return;
  // marked's #n masks reflink spans in the TEXT first (replacing
  // their contents with 'a's), before the code-span/link scan, so a
  // backtick inside a masked span cannot open a phantom code span
  // outside it (inst4 doc-23: the '`' after 'browser' must not pair
  // with the '`' before 'i18n'; fresh2 inst1 doc-21: the '`' after
  // 'tsconfig.json()' must not pair with the '`' before 'because').
  // The masking is length-preserving, so interval positions still
  // refer to the original text.
  let scanText = text;
  if (refs && refs.size > 0 && text.indexOf('[') !== -1) {
    const cb = (r) => {
      const o = r.lastIndexOf('[');
      if (!refs.has(normalizeLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const label = r.slice(1, o - 1);
        if (reflinkLabelHasLink(label, refs)) {
          return '[' + label.replace(REFLINK_SEARCH_RE, cb) + '][' + 'a'.repeat(r.length - o - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    scanText = text.replace(REFLINK_SEARCH_RE, cb);
  }
  const ot = scanText.replace(MASK_OT_RE, (n, s, r) => r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n);
  // Formed reference links, for the phantom-code-span rule below
  // (moved up: the scan loop needs it while matching).
  const refLinks = [];
  for (const p of parts) if (p.k === P_LINK && typeof p.labelEnd === 'number' && typeof p.s === 'number') {
    if (p.labelEnd + 1 < text.length && text.charCodeAt(p.labelEnd + 1) === 91) refLinks.push([p.s, p.labelEnd]);
  }
  MASK_BLOCKSKIP_RE.lastIndex = 0;
  let m;
  const iv = [];
  while ((m = MASK_BLOCKSKIP_RE.exec(ot)) !== null) {
    if (m[0].length === 0) { MASK_BLOCKSKIP_RE.lastIndex++; continue; }
    // isCode: starts with a backtick; runLen: the opening backtick-run
    // length for a code-span interval (named group b).
    const isCode = m[0].charCodeAt(0) === 96;
    const runLen = m.groups && m.groups.b ? m.groups.b.length : 0;
    iv.push([m.index, m.index + m[0].length, isCode, runLen]);
  }
  // marked's #n reflink masking: a '[label][ref]' span whose ref is a
  // known link definition hides its delimiters from the emphasis
  // closer scan (see reflinkMaskIntervals). Not a code span, so the
  // phantom-code-span filter below keeps it.
  if (refs && refs.size > 0 && text.indexOf('[') !== -1) {
    for (const [a, b] of reflinkMaskIntervals(text, refs)) iv.push([a, b, false, 0]);
  }
  // A phantom code-span interval must not cross the ']' closing a
  // REFERENCE link's label ('[' after ']') WHEN the interval's
  // opening backtick sits INSIDE that label: marked parses the
  // reference link first, so a backtick inside the label cannot pair
  // with one outside it (inst0 doc-30: the lone '`' after ``many``
  // in '[list write ``many` link run][browser updates]' must not
  // pair with the '`' before `renderer.code` and swallow the
  // '_by with one a_' between them). But a phantom pairing CAN cross
  // the ']' of an INLINE link ('(' after ']'): doc-16/28 ('[values
  // ``guide` in](#should)', '[issue read two ``small`](...)') still
  // mask the emphasis after the link. And a pairing whose opening
  // backtick is OUTSIDE the label (doc-35: no backtick in the label
  // at all) is unaffected. (With the reflink text-masking above, a
  // phantom can no longer open inside a masked span at all; the
  // filter stays as a fallback for unmasked labels.)
  const kept = [];
  for (const [a, b, isCode, runLen] of iv) {
    if (isCode) {
      let drop = false;
      for (const [ls, le] of refLinks) if (a > ls && a < le && b > le) { drop = true; break; }
      if (drop) continue;
    }
    kept.push([a, b]);
  }
  if (kept.length === 0) return;
  const iv2 = kept;
  for (const p of parts) {
    if (p.k !== P_DELIM) continue;
    for (let k = 0; k < iv2.length; k++) {
      if (p.s >= iv2[k][0] && p.s < iv2[k][1]) {
        // A delimiter inside a masked span (phantom code span / link /
        // tag) can still OPEN but cannot CLOSE: marked finds the opener
        // in the original text (emStrongLDelim) and scans for the
        // closer only in the masked text (emStrongRDelim), so a hidden
        // opener still matches a visible closer (inst2 doc-34:
        // '_option small uses `npx`_' becomes em), while a hidden
        // closer never matches (doc-16: '*small release **same***'
        // stays literal because its *** closer is masked too).
        p.canClose = false; p.oClose = false;
        break;
      }
    }
  }
}

function processEmphasis(parts, text) {
  for (const p of parts) if (p.k === P_LINK) processEmphasis(p.children, text);
  // collect delimiter indices in order
  const delims = [];
  for (let idx = 0; idx < parts.length; idx++) if (parts[idx].k === P_DELIM) delims.push(idx);
  for (let di = 0; di < delims.length; di++) {
    const closerIdx = delims[di];
    const closer = parts[closerIdx];
    // m/f/use of the last successful match in this closer's loop, used
    // after the loop to place the closer's leftover characters.
    let lastM = 0, lastF = 0, lastUse = 0;
    // spans matched by this closer; the kill of inner delimiters is
    // deferred until this closer's loop finishes (see below).
    const spans = [];
    while (closer.canClose && !closer.dead && closer.usedOpen + closer.usedClose < closer.n) {
      // find the LEFTMOST opener that can match this closer: marked
      // processes openers left to right, so the leftmost opener claims
      // the closer (the nearest-first order split a multi-char closer
      // across two ems where marked makes one strong, e.g. doc-11
      // '**a *b **c**d* e**'). For each opener the full remaining length
      // is tried first; shorter lengths are tried only when the opener
      // matches no later closer at full length — marked retries a failed
      // run one char at a time as the text rule consumes a literal char
      // (cm-442 '**foo*' -> '*<em>foo</em>'), but a full-length match
      // against a later closer is always claimed first (cm-429).
      // Two passes: strong matches (full m accounting) first, then weak
      // matches (the early return) — a weak match never steals a closer
      // that a later opener can match strongly (doc-26), but it still
      // emulates marked's recursion when no opener can (cm-408).
      const tryCandidate = (oi, strong) => {
        const cand = parts[delims[oi]];
        if (cand.k !== P_DELIM || cand.dead || !cand.canOpen || cand.usedOpen + cand.usedClose >= cand.n) return 0;
        if (cand.ch !== closer.ch) return 0;
        if (closer.ch === 126 && cand.n !== closer.n) return 0;
        const rem = cand.n - cand.usedOpen - cand.usedClose;
        // A weak match is an inner match inside a span the opener closes
        // with a later closer, or the outer match itself: it is only
        // valid when the opener can strongly match some later closer
        // (cm-408: D1 weakly matches D2 because it strongly matches D3)
        // or this closer at its full run length (cm-408: the outer D1-D3
        // match uses k=2, not the 1 char left after D1-D2; the '****'
        // opener in inst0 doc-11 can match no closer at all, so it
        // must stay literal).
        const weakOk = () => {
          if (strong) return true;
          if (emphasisCanMatch(parts, delims, oi, di, cand.n, true, text)) return true;
          for (let cj = di + 1; cj < delims.length; cj++) {
            const c2 = parts[delims[cj]];
            if (c2.k !== P_DELIM || c2.ch !== closer.ch || !c2.canClose || c2.dead || c2.usedOpen + c2.usedClose >= c2.n) continue;
            if (emphasisCanMatch(parts, delims, oi, cj, undefined, true, text)) return true;
          }
          return false;
        };
        // full length (marked's emStrong uses the whole run)
        if (closer.ch === 126) {
          if (emphasisCanMatch(parts, delims, oi, di, undefined, strong, text)) return weakOk() ? rem : 0;
        } else {
          const a = rem, b = closer.n;
          const rule3 = (cand.canClose || closer.canOpen) && (a + b) % 3 === 0 && (a % 3 !== 0 || b % 3 !== 0);
          if (!rule3 && emphasisCanMatch(parts, delims, oi, di, rem, strong, text)) return weakOk() ? rem : 0;
        }
        // shorter lengths (not for '~'): only when no later closer
        // matches this opener at full length. A reduced opener is
        // preceded by a char of the same run, so marked's RDelim scan
        // breaks out entirely on a both-flanking closer (the `o` flag)
        // instead of matching it — e.g. '**browser cache **stream or
        // `` a ` b ``****' leaves every '**' literal, while cm-442
        // '**foo*' still retries because its closer is closer-only.
        if (closer.ch !== 126 && rem > 1 && !(closer.canOpen && closer.canClose)) {
          // A later full-length match blocks the retry ONLY when it
          // would consume the whole opener (use >= rem): marked's
          // re-tokenization lets a leftover opener char match an
          // earlier closer afterwards (e.g. '*value **files *only**
          // an*' — the '**' opener matches the final '*' with use 1,
          // leaving one '*' to match the '**' closer as the middle
          // em). When the later closer is shorter than the opener,
          // the retry is allowed.
          let matchesLater = false;
          for (let cj = di + 1; cj < delims.length; cj++) {
            const c2 = parts[delims[cj]];
            if (c2.k !== P_DELIM || c2.ch !== closer.ch || !c2.canClose || c2.dead || c2.usedOpen + c2.usedClose >= c2.n) continue;
            if (emphasisCanMatch(parts, delims, oi, cj, undefined, strong, text)) {
              const c2rem = c2.n - c2.usedOpen - c2.usedClose;
              const use2 = (rem >= 2 && c2rem >= 2) ? 2 : 1;
              if (use2 >= rem) { matchesLater = true; break; }
            }
          }
          if (!matchesLater) {
            for (let k = rem - 1; k >= 1; k--) {
              const a = k, b = closer.n;
              if ((cand.canClose || closer.canOpen) && (a + b) % 3 === 0 && (a % 3 !== 0 || b % 3 !== 0)) continue;
              if (!emphasisCanMatch(parts, delims, oi, di, k, strong, text)) continue;
              return weakOk() ? k : 0;
            }
          }
        }
        return 0;
      };
      let opener = null;
      let openerIdx = -1;
      let openerPos = -1;
      let openerK = 0;
      for (let pass = 0; pass < 2 && !opener; pass++) {
        const strong = pass === 0;
        for (let oi = 0; oi < di; oi++) {
          const kUsed = tryCandidate(oi, strong);
          if (!kUsed) continue;
          opener = parts[delims[oi]];
          openerIdx = delims[oi];
          openerPos = oi;
          openerK = kUsed;
          break;
        }
      }
      if (!opener) break;
      // use: the opener side is capped by the chars still unused in the
      // run (an inner match may already have consumed part of it), even
      // though the m accounting used the whole run.
      const effOpen = Math.min(openerK, opener.n - opener.usedOpen - opener.usedClose);
      const use = (effOpen >= 2 && closer.n - closer.usedClose - closer.usedOpen >= 2) ? 2 : 1;
      if (closer.ch !== 126 && openerPos >= 0) {
        const mf = emphasisMF(parts, delims, openerPos, di, openerK, text);
        lastM = mf.m; lastF = mf.f;
      }
      lastUse = use;
      // strikethrough (~ or ~~) always renders <del>, never <em>/<strong>
      const tag = closer.ch === 126 ? 'del' : (use === 2 ? 'strong' : 'em');
      if (!opener.opens) opener.opens = [];
      if (!closer.closes) closer.closes = [];
      opener.opens.push(tag);
      // closes carry the opener's part index and a match sequence so the
      // render order can be fixed to innermost-first below (the
      // leftmost-first match order pushes the outer span's close first).
      closer.closes.push([tag, openerIdx, closer.closes.length]);
      // This closer run is now shared: a later match on its leftover
      // chars uses the strict rule in emphasisCanMatch (see above).
      closer.strictUsed = true;
      opener.usedOpen += use;
      closer.usedClose += use;
      spans.push([openerIdx, closerIdx]);
      if (opener.usedOpen >= opener.n) opener.canOpen = false;
      if (closer.usedClose >= closer.n) closer.canClose = false;
    }
    // A delimiter left unmatched strictly inside a newly created span
    // can no longer open or close anything outside it (e.g. cm-469:
    // the '_' inside '*foo _bar*' never matches the trailing '_';
    // cm-470: the '*' inside '__bar *baz bim__' never matches the
    // final '*'). Its literal characters still render. Deferred until
    // this closer's loop finishes so an inner delimiter can still match
    // this same closer's remaining characters: with leftmost-first
    // matching the outer span is made first (cm-414 '*foo **bar***':
    // the '*' opener's em is made before the '**' opener's strong, and
    // the '**' must not be killed in between).
    for (const [oIdx, cIdx] of spans) {
      for (let mi = oIdx + 1; mi < cIdx; mi++) {
        const mp = parts[mi];
        if (mp.k === P_DELIM && mp.usedOpen + mp.usedClose < mp.n) mp.dead = true;
      }
    }
    // After this closer's loop finishes, place its leftover characters.
    // Marked includes b = min(runLen, runLen + m + f) characters of the
    // closer run in the span it just closed; the b - lastUse characters
    // beyond the closing delimiter render INSIDE the span (e.g. doc-30
    // '**by command *tool*one***' keeps one '*' inside the strong),
    // while any further leftover renders OUTSIDE (e.g. '**foo***' ->
    // '<strong>foo</strong>*'). Set only now — the closer's remaining
    // characters may still be needed by a later nested match.
    if (closer.closes && closer.usedOpen + closer.usedClose < closer.n) {
      const b = Math.min(closer.n, closer.n + lastM + lastF);
      const litIn = b - lastUse;
      if (litIn > 0) closer.litIn = litIn;
    }
  }
  // Fix the close-tag order on every delimiter to innermost-first:
  // spans closing at the same part are nested by opener position (a
  // later opener is deeper), and for one opener the earlier match is
  // deeper. Then drop the bookkeeping so emitParts sees plain tags.
  for (const p of parts) {
    if (p.k === P_DELIM && p.closes && p.closes.length > 1) {
      p.closes.sort((a, b) => (b[1] - a[1]) || (a[2] - b[2]));
    }
    if (p.k === P_DELIM && p.closes) p.closes = p.closes.map((c) => c[0]);
  }
}

// Render link children to plain text (for img alt attributes): no tags,
// code spans as their text, entities as decoded. `text` is the scanned
// source string (for text parts).
function plainTextOf(children, text, out) {
  for (const ch of children) {
    if (ch.k === P_TEXT) {
      if (ch.s >= 0) out.push(text.slice(ch.s, ch.e));
      else out.push(ch.lit);
    } else if (ch.k === P_DELIM) {
      const lit = ch.n - ch.usedOpen - ch.usedClose;
      if (lit > 0) out.push(String.fromCharCode(ch.ch).repeat(lit));
    } else if (ch.k === P_BRACKET) out.push(ch.img ? '![' : '[');
    else if (ch.k === P_CODE) out.push(ch.raw);
    else if (ch.k === P_BR) out.push('\n');
    else if (ch.k === P_HTML) out.push(ch.s);
    else if (ch.k === P_AUTOLINK) out.push(ch.display);
    else if (ch.k === P_LINK) plainTextOf(ch.children, text, out);
  }
}

// Emit parts to the output chunk array. `text` is the scanned string (for
// text parts); when emitting link children, pass their own handling.
function emitParts(parts, text, out) {
  for (const p of parts) {
    switch (p.k) {
      case P_TEXT:
        if (p.raw) {
          // inside a raw block (<pre|code|kbd|script>): verbatim,
          // no escaping and no entity decoding (marked's inRawBlock)
          if (p.s >= 0) out.push(text.slice(p.s, p.e));
          else out.push(p.lit);
        } else if (p.s >= 0) escapeText(out, text, p.s, p.e);
        else escapeText(out, p.lit, 0, p.lit.length);
        break;
      case P_DELIM: {
        const lit = p.n - p.usedOpen - p.usedClose;
        // litIn: leftover characters of a closer run render INSIDE the
        // span it closed, before the closing tag (e.g. doc-30 keeps one
        // '*' inside the strong); the rest renders after the tag.
        const litIn = p.litIn || 0;
        if (litIn > 0) out.push(String.fromCharCode(p.ch).repeat(litIn));
        if (p.closes) for (const t of p.closes) out.push(t === 'em' ? '</em>' : t === 'del' ? '</del>' : '</strong>');
        if (lit - litIn > 0) out.push(String.fromCharCode(p.ch).repeat(lit - litIn));
        if (p.opens) for (let k = p.opens.length - 1; k >= 0; k--) out.push(p.opens[k] === 'em' ? '<em>' : p.opens[k] === 'del' ? '<del>' : '<strong>');
        break;
      }
      case P_CODE:
        out.push('<code>', p.html, '</code>');
        break;
      case P_LINK: {
        if (p.img) {
          const altParts = [];
          plainTextOf(p.children, text, altParts);
          const alt = escapeStr(altParts.join(''));
          out.push('<img src="');
          escapeNoEncodeText(out, p.href, 0, p.href.length);
          out.push('" alt="', alt, '"');
          if (p.title !== null) { out.push(' title="'); escapeNoEncodeText(out, p.title, 0, p.title.length); out.push('"'); }
          out.push('>');
        } else {
          out.push('<a href="');
          escapeNoEncodeText(out, p.href, 0, p.href.length);
          out.push('"');
          if (p.title !== null) { out.push(' title="'); escapeNoEncodeText(out, p.title, 0, p.title.length); out.push('"'); }
          out.push('>');
          emitParts(p.children, text, out);
          out.push('</a>');
        }
        break;
      }
      case P_AUTOLINK:
        out.push('<a href="');
        escapeNoEncodeText(out, p.href, 0, p.href.length);
        out.push('">');
        escapeText(out, p.display, 0, p.display.length);
        out.push('</a>');
        break;
      case P_HTML:
        out.push(p.s);
        break;
      case P_BR:
        out.push('<br>');
        break;
      case P_BRACKET:
        out.push(p.img ? '![' : '[');
        break;
    }
  }
}

// Parse inline content of `text` (a paragraph, heading, table cell, ...)
// into the output chunk array.
function inlineTo(text, refs, out) {
  if (text.length === 0) return;
  const parts = [];
  const stack = [];
  scanInline(text, refs, parts, stack);
  applyEmphasisMask(text, parts, refs);
  processEmphasis(parts, text);
  emitParts(parts, text, out);
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body', 'caption',
  'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'frame', 'frameset',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hr', 'html', 'iframe',
  'legend', 'li', 'link', 'main', 'menu', 'menuitem', 'nav', 'noframes', 'ol',
  'optgroup', 'option', 'p', 'param', 'search', 'section', 'summary', 'table',
  'tbody', 'td', 'tfoot', 'th', 'thead', 'title', 'tr', 'track', 'ul',
]);

// Line cursor state for the line being processed. `tabLeft` is the number
// of columns left of a partially consumed tab at `pos` (the tab itself is
// not advanced past until tabLeft reaches 0).
let L = null; // {s, pos, col, tabLeft}

function curChar() {
  if (L.tabLeft > 0) return 32;
  if (L.pos >= L.s.length) return -1;
  return L.s.charCodeAt(L.pos);
}

function curIsBlank() {
  for (let p = L.pos; p < L.s.length; p++) {
    const c = L.s.charCodeAt(p);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// The rest of the line from the cursor (partial-tab remainder as spaces).
function curRest() {
  if (L.tabLeft > 0) return ' '.repeat(L.tabLeft) + L.s.slice(L.pos + 1);
  return L.s.slice(L.pos);
}

function saveCur() {
  return { pos: L.pos, col: L.col, tabLeft: L.tabLeft };
}

function restoreCur(st) {
  L.pos = st.pos; L.col = st.col; L.tabLeft = st.tabLeft;
}

// Consume one column of a space or tab (a tab is partially consumed).
function consumeOneSpace() {
  if (L.tabLeft > 0) {
    L.tabLeft--;
    L.col++;
    if (L.tabLeft === 0) L.pos++;
    return true;
  }
  const c = curChar();
  if (c === 32) { L.pos++; L.col++; return true; }
  if (c === 9) {
    const w = 4 - (L.col & 3);
    if (w === 1) { L.pos++; L.col++; }
    else { L.tabLeft = w - 1; L.col++; }
    return true;
  }
  return false;
}

// Consume up to n columns of indent (spaces/tabs). Returns true when n
// columns were consumed, false when a non-space character was hit first.
// A tab that straddles the boundary leaves its remainder in tabLeft.
function advanceCols(n) {
  while (n > 0) {
    if (L.tabLeft > 0) {
      const take = L.tabLeft < n ? L.tabLeft : n;
      L.tabLeft -= take;
      L.col += take;
      n -= take;
      if (L.tabLeft === 0) L.pos++;
      continue;
    }
    if (L.pos >= L.s.length) return false;
    const c = L.s.charCodeAt(L.pos);
    if (c === 32) { L.pos++; L.col++; n--; }
    else if (c === 9) {
      const w = 4 - (L.col & 3);
      if (w <= n) { L.pos++; L.col += w; n -= w; }
      else { L.tabLeft = w - n; L.col += n; n = 0; }
    } else return false;
  }
  return true;
}

// Skip exactly n columns of whitespace; false if it cannot.
function skipCols(n) {
  const st = saveCur();
  if (!advanceCols(n)) { restoreCur(st); return false; }
  return true;
}

function newNode(t) {
  return { t, children: [], open: true };
}

// --- block-start matchers (cursor at the position to test) ---

// ATX heading: #{1,6} followed by space/tab/EOL. Returns {level, content}
// or null. `content` is the rest of the line INCLUDING the separator space
// (needed so a trailing '#' preceded by that space is a closing sequence).
function matchAtx() {
  const st = saveCur();
  advanceCols(3);
  let level = 0;
  while (level < 6 && curChar() === 35) {
    L.pos++; L.col++; level++;
  }
  if (level === 0) { restoreCur(st); return null; }
  const c = curChar();
  if (c !== -1 && c !== 32 && c !== 9) { restoreCur(st); return null; }
  return { level, content: curRest() };
}

// Thematic break: 3+ of the same -, *, _ with optional spaces between.
function matchHr() {
  const st = saveCur();
  advanceCols(3);
  const c = curChar();
  if (c !== 45 && c !== 42 && c !== 95) { restoreCur(st); return false; }
  let count = 0;
  while (true) {
    const d = curChar();
    if (d === c) { count++; L.pos++; L.col++; }
    else if (d === 32 || d === 9) { L.pos++; L.col++; }
    else break;
  }
  if (count < 3 || curChar() !== -1) { restoreCur(st); return false; }
  return true;
}

// Setext underline: =+ or -+ (up to 3 spaces indent, trailing spaces ok).
// Returns 1, 2 or 0. Spaces between the markers (e.g. '= =') are NOT valid.
function matchSetext() {
  const st = saveCur();
  advanceCols(3);
  const c = curChar();
  if (c !== 61 && c !== 45) { restoreCur(st); return 0; }
  while (curChar() === c) { L.pos++; L.col++; }
  while (curChar() === 32 || curChar() === 9) { L.pos++; L.col++; }
  if (curChar() !== -1) { restoreCur(st); return 0; }
  return c === 61 ? 1 : 2;
}

// Fenced code opening: 3+ ` or ~. Returns {ch, len} or null. For ` fences
// the info string must not contain a backtick.
function matchFence() {
  const st = saveCur();
  const col0 = L.col;
  advanceCols(3);
  const indent = L.col - col0;
  const fenceCol = L.col; // absolute column of the fence marker
  const c = curChar();
  if (c !== 96 && c !== 126) { restoreCur(st); return null; }
  let len = 0;
  while (curChar() === c) { L.pos++; L.col++; len++; }
  if (len < 3) { restoreCur(st); return null; }
  if (c === 96) {
    // info string must not contain a backtick
    for (let p = L.pos; p < L.s.length; p++) {
      if (L.s.charCodeAt(p) === 96) { restoreCur(st); return null; }
    }
  }
  return { ch: c, len, indent, fenceCol };
}

// Does a (container-stripped) fence content line start with a run of
// the fence char at least as long as the opener? (A closing fence is
// caught separately by matchFenceClose; this is for lines like
// '```inner backticks```' that start with such a run but have text
// after it, so they stay content yet act as a fence boundary.)
function startsFenceRun(s, ch, len) {
  let i = 0;
  while (i < s.length && (s.charCodeAt(i) === 32 || s.charCodeAt(i) === 9)) i++;
  if (i > 3) return false;
  let n = 0;
  while (i + n < s.length && s.charCodeAt(i + n) === ch) n++;
  return n >= len;
}

// Is this a closing fence for the given fence? (3+ same char, at least as
// long as the opener, nothing but spaces after.)
function matchFenceClose(ch, len) {
  const st = saveCur();
  advanceCols(3);
  if (curChar() !== ch) { restoreCur(st); return false; }
  let n = 0;
  while (curChar() === ch) { L.pos++; L.col++; n++; }
  if (n < len) { restoreCur(st); return false; }
  while (curChar() === 32 || curChar() === 9) { L.pos++; L.col++; }
  if (curChar() !== -1) { restoreCur(st); return false; }
  return true;
}

// HTML block start. Returns {type, tag} (tag = the type-1 tag name, lower
// case) or null. Type 1 is an opening <script|pre|style|textarea> tag only
// (a closing </pre> etc. is NOT a start); type 6 excludes those four tags.
function matchHtmlBlock() {
  const st = saveCur();
  advanceCols(3);
  if (curChar() !== 60) { restoreCur(st); return null; }
  const rest = L.s.slice(L.pos);
  // type 2: <!--
  if (rest.startsWith('<!--')) { restoreCur(st); return { type: 2, tag: null }; }
  // type 3: <?
  if (rest.startsWith('<?')) { restoreCur(st); return { type: 3, tag: null }; }
  // type 4: <! + letter
  if (rest.startsWith('<!')) {
    const c = rest.charCodeAt(2);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { restoreCur(st); return { type: 4, tag: null }; }
  }
  // type 5: <![CDATA[
  if (rest.startsWith('<![CDATA[')) { restoreCur(st); return { type: 5, tag: null }; }
  // type 1: script/pre/style/textarea (opening tag only). The tag name may
  // be at the end of the line (the tag continues on the next line).
  const m1 = /^<(script|pre|style|textarea)(?:[ \t>]|\/>|$)/i.exec(rest);
  if (m1) { restoreCur(st); return { type: 1, tag: m1[1].toLowerCase() }; }
  // type 6: block-level tag (tag name may end the line too)
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)(?:[ \t>]|\/>|$)/.exec(rest);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) { restoreCur(st); return { type: 6, tag: null }; }
  // type 7: complete open/close tag alone on the line (the tag must be
  // fully valid, with proper attributes)
  const tagEnd = parseHtmlTag(rest, 0);
  if (tagEnd > 0 && /^[ \t]*$/.test(rest.slice(tagEnd))) { restoreCur(st); return { type: 7, tag: null }; }
  restoreCur(st);
  return null;
}

// Does this line contain the end string for an HTML block of the given type?
// Type 1 ends at the closing tag matching its start tag.
function htmlEndsOnLine(type, tag, line) {
  if (type === 1) {
    return line.toLowerCase().indexOf('</' + tag) !== -1;
  }
  if (type === 2) return line.indexOf('-->') !== -1;
  if (type === 3) return line.indexOf('?>') !== -1;
  if (type === 4) return line.indexOf('>') !== -1;
  if (type === 5) return line.indexOf(']]>') !== -1;
  return false;
}

// List marker at the cursor. Returns {ordered, bullet, delim, start, width,
// startCol, markerCol} or null. `width` is the marker's column width.
// `startCol` is the column before the marker's indent was consumed (the
// parent container's content start); `markerCol` is the marker's column.
function matchListMarker() {
  const st = saveCur();
  const startCol = L.col;
  advanceCols(3);
  const markerCol = L.col;
  const c = curChar();
  if (c === 45 || c === 42 || c === 43) {
    const next = L.pos + 1 < L.s.length ? L.s.charCodeAt(L.pos + 1) : -1;
    if (next !== 32 && next !== 9 && next !== -1) { restoreCur(st); return null; }
    L.pos++; L.col++;
    return { ordered: false, bullet: c, delim: 0, start: 0, width: 1, startCol, markerCol };
  }
  if (isDigit(c)) {
    let j = L.pos;
    let num = 0;
    let digits = 0;
    while (j < L.s.length && isDigit(L.s.charCodeAt(j)) && digits < 9) {
      num = num * 10 + (L.s.charCodeAt(j) - 48);
      digits++;
      j++;
    }
    if (digits === 0 || digits > 9) { restoreCur(st); return null; }
    if (j < L.s.length && isDigit(L.s.charCodeAt(j))) { restoreCur(st); return null; } // >9 digits
    if (j >= L.s.length) { restoreCur(st); return null; }
    const d = L.s.charCodeAt(j);
    if (d !== 46 && d !== 41) { restoreCur(st); return null; }
    const next = j + 1 < L.s.length ? L.s.charCodeAt(j + 1) : -1;
    if (next !== 32 && next !== 9 && next !== -1) { restoreCur(st); return null; }
    const width = digits + 1;
    L.pos = j + 1;
    L.col += width;
    return { ordered: true, bullet: 0, delim: d, start: num, width, startCol, markerCol };
  }
  restoreCur(st);
  return null;
}

// Count the columns of whitespace following a list marker (from the
// cursor). Returns the count (may exceed 4).
function countMarkerSpaces() {
  let n = 0;
  let pos = L.pos;
  let col = L.col;
  let tabLeft = L.tabLeft;
  while (true) {
    if (tabLeft > 0) { n += tabLeft; col += tabLeft; tabLeft = 0; pos++; continue; }
    if (pos >= L.s.length) break;
    const c = L.s.charCodeAt(pos);
    if (c === 32) { n++; col++; pos++; }
    else if (c === 9) { const w = 4 - (col & 3); n += w; col += w; pos++; }
    else break;
  }
  return n;
}

// Indented code: indent of 4+ columns from the cursor.
function matchIndentedCode() {
  const st = saveCur();
  if (!advanceCols(4)) { restoreCur(st); return false; }
  return true;
}

// --- container matchers ---

function matchQuote() {
  const st = saveCur();
  const colBefore = L.col;
  advanceCols(3);
  if (curChar() !== 62) { restoreCur(st); return false; }
  L.pos++; L.col++;
  const markerLen = L.col - colBefore;
  // Optional single space/tab after '>'. marked expands the whitespace
  // run after the marker with J(ws, markerLen) and then strips one
  // column; a tab's width is based on markerLen, NOT the absolute
  // column, so outer quote widths must not leak into the inner level.
  // Reset L.col to the virtual column (markerLen + whitespace consumed).
  const c = curChar();
  if (c === 32) { L.pos++; L.col = markerLen + 1; }
  else if (c === 9) {
    const w = 4 - (markerLen & 3);
    if (w === 1) { L.pos++; L.col = markerLen + 1; }
    else { L.tabLeft = w - 1; L.col = markerLen + 1; }
  } else {
    L.col = markerLen;
  }
  return true;
}

function matchItem(item) {
  const st = saveCur();
  if (!advanceCols(item.contentIndent)) { restoreCur(st); return false; }
  return true;
}

// --- node helpers ---

function addChild(parent, node) {
  node.parent = parent;
  parent.children.push(node);
}

function replaceInParent(node, newNode) {
  const idx = node.parent.children.indexOf(node);
  node.parent.children[idx] = newNode;
  newNode.parent = node.parent;
}

function removeFromParent(node) {
  const idx = node.parent.children.indexOf(node);
  if (idx !== -1) node.parent.children.splice(idx, 1);
}

// Compute a list item's content indent from the marker info. The cursor is
// right after the marker. The indent is the number of columns from the
// parent container's content start (marker.startCol) to the item's content
// start, so it works both at the top level and inside block quotes.
// Positions the cursor at the content start. Returns the indent.
function markerContentIndent(marker) {
  const n = countMarkerSpaces();
  // is there any non-whitespace content after the marker?
  let empty = true;
  for (let p = L.pos; p < L.s.length; p++) {
    const cc = L.s.charCodeAt(p);
    if (cc !== 32 && cc !== 9) { empty = false; break; }
  }
  if (empty) {
    // content indent = marker start + width + 1 (relative to startCol)
    return (marker.markerCol - marker.startCol) + marker.width + 1;
  }
  if (n <= 4) {
    advanceCols(n);
    return L.col - marker.startCol;
  }
  // 5+ spaces: only one is the separator; the rest is content
  advanceCols(1);
  return L.col - marker.startCol;
}

// Try to parse a single link reference definition starting at text[i]
// (which must be '['). Returns {key, dest, title, end} where end is the
// index just past the definition's line (or the title line), or null.
function tryParseDef(text, i) {
  const n = text.length;
  const lab = parseLinkLabel(text, i);
  if (!lab) return null;
  const key = normalizeLabel(lab.label);
  if (key === '') return null;
  let j = lab.next;
  if (j >= n || text.charCodeAt(j) !== 58) return null;
  j++;
  j = skipInlineWs(text, j);
  const isAngle = j < n && text.charCodeAt(j) === 60;
  const d = parseLinkDest(text, j);
  if (!d) return null;
  if (!isAngle && d.dest === '') return null;
  j = d.next;
  const jAfterDest = j;
  while (j < n && (text.charCodeAt(j) === 32 || text.charCodeAt(j) === 9)) j++;
  let title = null;
  if (j < n) {
    const q = text.charCodeAt(j);
    if (q === 34 || q === 39 || q === 40) {
      if (j === jAfterDest) return null;
      const t = parseLinkTitle(text, j);
      if (t) { title = t.title; j = t.next; }
    }
  }
  if (title === null) {
    let k = j;
    while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
    if (k < n && text.charCodeAt(k) === 10) {
      let j2 = k + 1;
      while (j2 < n && (text.charCodeAt(j2) === 32 || text.charCodeAt(j2) === 9)) j2++;
      if (j2 < n) {
        const q = text.charCodeAt(j2);
        if (q === 34 || q === 39 || q === 40) {
          const t = parseLinkTitle(text, j2);
          if (t) {
            let k2 = t.next;
            while (k2 < n && (text.charCodeAt(k2) === 32 || text.charCodeAt(k2) === 9)) k2++;
            if (k2 < n && text.charCodeAt(k2) !== 10) {
              title = null;
              j = k;
            } else {
              title = t.title;
              j = t.next;
            }
          }
        }
      }
    }
  }
  let k = j;
  while (k < n && (text.charCodeAt(k) === 32 || text.charCodeAt(k) === 9)) k++;
  if (k < n && text.charCodeAt(k) !== 10) return null;
  return { key, dest: d.dest, title, end: k < n ? k + 1 : k };
}

// --- link reference definitions ---

// Parse link reference definitions from the start of a paragraph's joined
// text. Adds to refs (first definition wins). Returns the remaining text.
function stripLinkDefs(text, refs) {
  let pos = 0;
  const n = text.length;
  while (pos < n) {
    const save = pos;
    // indent up to 3 columns
    let col = 0, i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 32) { col++; i++; if (col > 3) break; }
      else if (c === 9) { col += 4 - (col & 3); i++; if (col > 3) break; }
      else break;
    }
    if (col > 3) break;
    if (i >= n || text.charCodeAt(i) !== 91) break;
    const def = tryParseDef(text, i);
    if (!def) break;
    if (!refs.has(def.key)) {
      refs.set(def.key, { dest: def.dest, title: def.title === null ? null : resolveEscapes(def.title) });
    }
    pos = def.end;
    if (pos === save) break; // safety: no progress
  }
  return text.slice(pos);
}

// --- GFM tables ---

// Split a table row line into cells (unescaped '|' outside code spans).
// Leading/trailing pipes are dropped.
function splitTableRow(line) {
  const cells = [];
  let cur = '';
  let i = 0;
  const n = line.length;
  // marked's splitCells does NOT protect '|' inside code spans at all:
  // it splits on every unescaped '|'. A '|' inside a code span is only
  // safe when escaped ('\|'), which becomes a literal '|' in the cell.
  // (verified: '| 1 | `x | y` | 3 |' splits into `x and y` cells in
  // marked; the earlier inCode tracking wrongly kept them together and
  // broke rows like '| [6][] | ``used` | `a \| b` |  |', where the '|'
  // after the mismatched ``used` span must split.)
  while (i < n) {
    const c = line.charCodeAt(i);
    if (c === 92 && i + 1 < n && line.charCodeAt(i + 1) === 124) {
      // escaped pipe: the table-level escape resolves to a literal '|'
      cur += '|';
      i += 2;
      continue;
    }
    if (c === 124) {
      cells.push(cur);
      cur = '';
      i++;
      continue;
    }
    cur += line[i];
    i++;
  }
  cells.push(cur);
  // marked's splitCells drops a leading/trailing cell that is empty
  // (whitespace-only) regardless of whether the line starts/ends with
  // '|': e.g. ' |  | from string | ...' loses its first cell.
  if (cells.length > 0 && cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells.map((s) => s.trim());
}

// Parse a delimiter row. Returns an array of alignments ('left','center',
// 'right', null) or null if the line is not a delimiter row.
function parseDelimRow(line) {
  const cells = splitTableRow(line);
  if (cells.length === 0) return null;
  const aligns = [];
  for (const cell of cells) {
    let s = cell;
    let left = false, right = false;
    if (s.startsWith(':')) { left = true; s = s.slice(1); }
    if (s.endsWith(':')) { right = true; s = s.slice(0, -1); }
    if (s.length === 0) return null;
    for (let i = 0; i < s.length; i++) {
      if (s.charCodeAt(i) !== 45) return null;
    }
    aligns.push(left && right ? 'center' : left ? 'left' : right ? 'right' : null);
  }
  return aligns;
}

// Try to interpret a paragraph's lines as a GFM table. Returns a table node
// or null.
function isTableStart(lines) {
  // the first two lines form a valid table header + delimiter row
  if (lines.length < 2) return false;
  const delim = parseDelimRow(lines[1]);
  if (!delim) return false;
  const header = splitTableRow(lines[0]);
  return header.length === delim.length;
}
function tryTable(lines) {
  if (lines.length < 2) return null;
  // the delimiter row may not be indented more than 3 spaces
  let ind = 0;
  for (let p = 0; p < lines[1].length; p++) {
    const c = lines[1].charCodeAt(p);
    if (c === 32) ind++;
    else if (c === 9) ind += 4 - (ind % 4);
    else break;
    if (ind > 3) return null;
  }
  const delim = parseDelimRow(lines[1]);
  if (!delim) return null;
  const header = splitTableRow(lines[0]);
  if (header.length !== delim.length) return null;
  const rows = [];
  let endIdx = lines.length;
  for (let k = 2; k < lines.length; k++) {
    // A row line indented 4+ columns is indented code, not a table
    // row: it ends the table (inst3 doc-26: '    # bar' after a table
    // becomes <pre><code># bar</code></pre>, not another row). A
    // whitespace-only line is an empty row, not code, even if it is a
    // tab (which alone reaches column 4).
    let ind = 0;
    let blank = true;
    for (let p = 0; p < lines[k].length; p++) {
      const c = lines[k].charCodeAt(p);
      if (c === 32) ind++;
      else if (c === 9) ind += 4 - (ind % 4);
      else { blank = false; break; }
    }
    if (!blank && ind >= 4) { endIdx = k; break; }
    const cells = splitTableRow(lines[k]);
    while (cells.length < delim.length) cells.push('');
    if (cells.length > delim.length) cells.length = delim.length;
    rows.push(cells);
  }
  return { t: 'table', align: delim, header, rows, children: [], open: false, endIdx };
}

// --- block finalization ---

function finalize(node, refs) {
  node.open = false;
  if (node.t === 'para') {
    const text = node.lines.join('\n');
    const rest = stripLinkDefs(text, refs);
    if (rest.trim() === '') { removeFromParent(node); return; }
    const lines = rest.split('\n');
    // A paragraph directly inside a list item: marked lexes the item's
    // text with top=false, so a continuation line indented 4+ columns
    // is indented code, absorbed into the preceding text token: 4
    // spaces are stripped and the code line's trailing newline becomes
    // a blank line before the next paragraph line (inst1 doc-11:
    // '     indented four' becomes ' indented four' + blank line).
    // Inside a blockquote marked lexes with top=true, so no absorption
    // happens there (cm-093: '    ===' stays as-is).
    // The absorption does NOT happen when the paragraph follows a
    // nested list in the same item (inst0 doc-30: a 6-space line after
    // the '3.' nested list stays 6 spaces, no blank line) — the
    // paragraph is then lexed as a fresh block, not as a continuation
    // of the item's text flow.
    if (node.parent && node.parent.t === 'item') {
      const sibs = node.parent.children;
      const idx = sibs.indexOf(node);
      let afterList = false;
      for (let s = 0; s < idx; s++) if (sibs[s].t === 'list') { afterList = true; break; }
      if (!afterList) {
      let lastCode = false;
      for (let i = 1; i < lines.length; i++) {
        if (lines[i].startsWith('    ')) {
          // A run of consecutive 4+-indented lines is ONE indented
          // code token in marked (its regex matches consecutive
          // indented lines together), so strip 4 spaces from each
          // and put NO blank line between them (inst4 doc-23: the
          // Write/Class/Npm/Last lines are one run). The code
          // token's text ends with the run's trailing newline, so
          // when more paragraph lines follow the run, a blank line
          // appears before them (inst1 doc-11: an absorbed line
          // followed by a lazy line leaves a blank line).
          let j = i;
          while (j < lines.length && lines[j].startsWith('    ')) {
            lines[j] = lines[j].slice(4);
            j++;
          }
          if (j < lines.length && lines[j] !== '') {
            lines.splice(j, 0, '');
            i = j; // skip to the inserted blank line
          } else {
            // run followed by a blank line, or run at the end
            if (j >= lines.length) lastCode = true;
            i = j - 1; // move past the run (a stripped line may still
            // start with 4 spaces when it had 8+ originally)
          }
        }
      }
      // A 4+-indented LAST line is indented code absorbed into the
      // paragraph: marked's code token text ends with '\n' (its match
      // ends with the line's own newline) UNLESS the code line is the
      // last line of the item's text (next is a sibling item or the
      // end of the list) — that is undone in the item/list finalize
      // below. Append tentatively here; the item finalize strips it
      // when the paragraph is the item's last child and was not
      // closed by a blank line, and the list finalize strips it for
      // the last item (marked trimEnds the last item's text).
      if (lastCode) {
        node.codeMergeNL = true;
      }
      } // !afterList
    }
    const table = tryTable(lines);
    if (table) {
      // Leftover lines after the table (a 4+-indented line ends it):
      // if they are all blank or indented 4+, they form an indented
      // code block after the table; otherwise this is not a table.
      if (table.endIdx < lines.length) {
        const rest = lines.slice(table.endIdx);
        const allCode = rest.every(ln => {
          let ind = 0;
          for (let p = 0; p < ln.length; p++) {
            const c = ln.charCodeAt(p);
            if (c === 32) ind++;
            else if (c === 9) ind += 4 - (ind % 4);
            else break;
          }
          return ind >= 4 || ln.trim() === '';
        });
        if (!allCode) { node.text = lines.join('\n'); }
        else {
          delete table.endIdx;
          replaceInParent(node, table);
          const code = newNode('code');
          code.lines = rest.map(ln => stripIndent(ln, 4));
          code.parent = node.parent;
          node.parent.children.splice(node.parent.children.indexOf(table) + 1, 0, code);
          finalize(code, refs);
        }
      } else {
        delete table.endIdx;
        replaceInParent(node, table);
      }
      return;
    }
    node.text = lines.join('\n');
    // A 4+-indented last line absorbed as indented code ends the
    // paragraph text with a newline: marked's item text keeps the
    // code line's newline when a blank line follows it inside the
    // item. Whether it survives is decided in the item/list finalize
    // below (kept only when the paragraph is the item's last child,
    // was closed by a blank line, and the item is not the list's
    // last item — marked trimEnds the last item's text).
    if (node.codeMergeNL) node.text += '\n';
  } else if (node.t === 'code') {
    while (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') {
      node.lines.pop();
    }
    if (node.lines.length === 0) removeFromParent(node);
  } else if (node.t === 'fence') {
    // one trailing blank line is stripped from fenced code content
    if (node.lines.length > 0 && node.lines[node.lines.length - 1] === '') node.lines.pop();
  } else if (node.t === 'item') {
    // A paragraph whose last line was absorbed as indented code
    // carries a trailing newline only when the code line is followed
    // by more content in the item (a blank line, a nested block).
    // When the paragraph is the item's last child and was not closed
    // by a blank line, the code line is the last line of the item's
    // text: marked's item text ends at the code line, no newline.
    const lastChild = node.children[node.children.length - 1];
    if (lastChild && lastChild.t === 'para' && lastChild.codeMergeNL && !lastChild.closedByBlank && lastChild.text.endsWith('\n')) {
      lastChild.text = lastChild.text.slice(0, -1);
      lastChild.codeMergeNL = false;
    }
  } else if (node.t === 'list') {
    // A codeMergeNL trailing newline survives only when the
    // indented-code run is not followed by a blank line within
    // the item text (marked merges a following code token into
    // the paragraph, and its code tokenizer strips the text's
    // trailing newline exactly when a blank line follows the
    // code — ge() keeps at most one trailing newline). That is:
    // (a) the paragraph is the item's last child, was closed by
    // a blank line, and the item is not the list's last item
    // (the blank line then belongs to the list, not the item
    // text — marked trimEnds the last item's text instead); or
    // (b) the paragraph is followed directly by a block in the
    // same item (no blank line), so the code run ends at a block
    // start. A paragraph followed by a blank line and more
    // content in the same item, or ending at the item's end
    // with no following newline, never keeps one.
    const items = node.children.filter(c => c.t === 'item');
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];
      const lastC = it.children[it.children.length - 1];
      for (const p of it.children) {
        if (p.t === 'para' && p.codeMergeNL && p.text.endsWith('\n')) {
          const keep = (p === lastC && p.closedByBlank && ii < items.length - 1)
            || (p !== lastC && !p.closedByBlank);
          if (!keep) { p.text = p.text.slice(0, -1); p.codeMergeNL = false; }
        }
      }
    }
  } else if (node.t === 'heading') {
    let s = node.text;
    if (node.atx) {
      const m = /[ \t]+#+[ \t]*$/.exec(s);
      if (m) s = s.slice(0, m.index);
    }
    node.text = s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  }
}

// --- the main block parser ---

function parseBlocks(lines, refs) {
  const root = newNode('doc');
  root.lineCount = lines.length;
  const open = [root];
  let blankPending = false;

  function tip() { return open[open.length - 1]; }

  function closeFrom(k) {
    while (open.length > k) {
      const node = open.pop();
      finalize(node, refs);
    }
  }

  // A new block is starting in phase 3: a blank line before it (and an
  // existing block in the innermost open item) makes the enclosing list
  // loose. Consumes blankPending: every block start resets it, so a
  // blank line before a fence/html/heading/hr/code cannot leak into a
  // later sibling item and wrongly loosen its list.
  function noteBlockStart() {
    if (!blankPending) return;
    blankPending = false;
    for (let k = open.length - 1; k >= 1; k--) {
      if (open[k].t === 'item') {
        if (open[k].children.length > 0) open[k].parent.loose = true;
        return;
      }
    }
  }

  // Does the line at the cursor start a block that can interrupt a paragraph?
  // (ATX heading, HR, fence, HTML block of type 1-6, list marker. A type-7
  // HTML block cannot interrupt a paragraph.) Restores the cursor.
  // A list marker can interrupt a paragraph only when the item is not
  // empty, and (for ordered lists) only when it starts with 1.
  function interruptsPara() {
    const st = saveCur();
    let hit = false;
    if (matchAtx()) hit = true;
    else if (matchHr()) hit = true;
    else if (matchFence()) hit = true;
    else if (matchQuote()) hit = true;
    else {
      const hb = matchHtmlBlock();
      if (hb) {
        if (hb.type !== 7) hit = true;
      } else {
        const lm = matchListMarker();
        if (lm) {
          // A marker that continues an open list is always allowed (it
          // ends the paragraph to start a sibling item). A marker inside
          // a list item also closes that list and starts a new one, so
          // the start-with-1 / non-empty rules do not apply there. Those
          // rules only gate a NEW list interrupting a paragraph that is
          // not inside a list.
          let continues = false;
          let inList = false;
          for (let s = open.length - 1; s >= 1; s--) {
            const nd = open[s];
            if (nd.t !== 'list') continue;
            inList = true;
            if (nd.ordered === lm.ordered &&
                (lm.ordered ? nd.delim === lm.delim : nd.bullet === lm.bullet)) {
              continues = true;
              break;
            }
          }
          if (continues || inList) hit = true;
          // ordered lists interrupt a paragraph only when starting at 1
          else if (!lm.ordered || lm.start === 1) {
            // the item must have content on its line (an empty item
            // cannot interrupt a paragraph)
            let p = L.pos;
            while (p < L.s.length && (L.s.charCodeAt(p) === 32 || L.s.charCodeAt(p) === 9)) p++;
            if (p < L.s.length) hit = true;
          }
        }
      }
    }
    restoreCur(st);
    return hit;
  }

  for (let li = 0; li < lines.length; li++) {
    L = { s: lines[li], pos: 0, col: 0, tabLeft: 0 };
    const blank = curIsBlank();

    // Phase 1: match open containers
    let failIdx = -1;
    let i = 1;
    while (i < open.length) {
      const node = open[i];
      if (node.t === 'list') { i++; continue; }
      if (node.t === 'quote') {
        // A truly blank line ends a block quote (there is no '>' to
        // match); a '>'-only line matches and stays open. List items,
        // unlike quotes, do span truly blank lines.
        if (!matchQuote()) { failIdx = i; break; }
        i++; continue;
      }
      if (node.t === 'item') {
        // A line blank after the outer containers matched is a blank
        // line inside the item (it stays open); only real content the
        // item cannot consume fails the match.
        if (blank || curIsBlank()) { i++; continue; }
        if (!matchItem(node)) { failIdx = i; break; }
        i++; continue;
      }
      break; // leaf tip
    }
    const allMatched = failIdx === -1;
    const t = tip();
    // Whether the tip sits inside a list item: a LAZY paragraph line
    // (one that failed to match a container) keeps a leading tab
    // literal when it is only in a blockquote — marked's quote
    // tokenizer expands the whitespace after '>' only for lines
    // that carry a '>' marker, and a lazy line has none — while a
    // lazy line inside a list item is part of the item text, whose
    // leading whitespace marked's list tokenizer expands (J()).
    // Normal continuation and first lines passed through a marker,
    // so they keep the open.length gates below.
    const inItem = open.some(o => o.t === 'item');
    // blankness of the rest of the line after the containers matched.
    // A line is blank here if the raw line is blank, or the rest is
    // empty; a line that still holds spaces after a container marker
    // (e.g. '>  ' leaving one space) is content, not a blank line.
    const restBlank = blank || (L.pos >= L.s.length && L.tabLeft === 0);

    // Phase 2: leaf tip
    if (t.t === 'para') {
      if (restBlank) {
        // marked's table regex only rejects a body line that is
        // spaces-only (` *\n`); a line that is whitespace-only but
        // contains a tab is a table row (all empty cells) — unless it
        // looks like indented code (`(?: {4}| {0,3}\t)[^\n]`, e.g.
        // ` \t ` has a space after the tab, so it is code, not a row).
        // So a tab-containing blank line inside a table-in-progress
        // paragraph stays a paragraph line instead of ending it.
        if (t.lines.length >= 2 && isTableStart(t.lines) && L.s.indexOf('\t') !== -1) {
          const rest = curRest();
          if (!/^(?: {4}| {0,3}\t)[^\n]/.test(rest)) {
            t.lines.push(rest);
            t.lastLazy = false;
            continue;
          }
        }
        // A blank line inside an indented code run that follows a
        // table: the paragraph's lines end with indented code (4+),
        // and the code run continues after the blank line(s). Absorb
        // the blank line as a paragraph line so tryTable()'s split
        // keeps the code block whole (inst2 doc-16: the code block
        // '1.  A paragraph / with two lines. / blank / indented code
        // / blank / > A block quote.' was split at the blank line).
        // Only at the top level, where the raw line indent is the
        // code indent. If the next non-blank line is not code, the
        // paragraph closes normally.
        if (open.length === 2 && t.lines.length >= 2 && isTableStart(t.lines)) {
          const last = t.lines[t.lines.length - 1];
          let lind = 0;
          for (let p = 0; p < last.length; p++) {
            const c = last.charCodeAt(p);
            if (c === 32) lind++;
            else if (c === 9) lind += 4 - (lind % 4);
            else break;
          }
          if (lind >= 4) {
            let j = li + 1;
            while (j < lines.length && lines[j].trim() === '') j++;
            if (j < lines.length) {
              let nind = 0;
              for (let p = 0; p < lines[j].length; p++) {
                const c = lines[j].charCodeAt(p);
                if (c === 32) nind++;
                else if (c === 9) nind += 4 - (nind % 4);
                else break;
              }
              if (nind >= 4) {
                t.lines.push('');
                t.lastLazy = false;
                continue;
              }
            }
          }
        }
        // a blank line counts for list looseness when it is blank at
        // the level of the paragraph's parent item (a raw blank line
        // always counts; a '>'-only line only when the paragraph sits
        // directly in an item, not nested inside a quote — cm-320)
        const parentIsItem = t.parent && t.parent.t === 'item';
        // A paragraph closed by a blank line: a 4+-indented last line
        // absorbed as indented code carries NO trailing newline (the
        // code token's match swallows the blank line and ge() strips
        // it), unlike one followed directly by another block.
        if (t.t === 'para') t.closedByBlank = true;
        closeFrom(allMatched ? open.length - 1 : failIdx);
        if (blank || parentIsItem) blankPending = true;
        continue;
      }
      // Blockquote chunk close: if the previous line for this paragraph
      // was a lazy line (it failed to match a container), and this line
      // re-enters a block quote that is an ancestor of the paragraph,
      // the lazy line ended the current quote chunk: the containers
      // between that quote and the paragraph (list/item) do not
      // continue into the new chunk, so close them and re-process the
      // line fresh inside the quote (T1: '> - item\n> cont\nlazy\n>
      // next' puts 'next' in a new <p> in the quote, not the <li>;
      // V: even a line that matches the item ends it; W: a new list
      // item after a lazy line starts a NEW list; inst0 doc-01,
      // inst1 doc-35). A plain paragraph directly in the quote has no
      // containers between, so it continues normally (T3). A lazy
      // line not inside a quote never triggers this (U). A following
      // lazy line (no '>') does not re-enter the quote, so consecutive
      // lazy lines keep continuing the paragraph (T2).
      if (t.lastLazyQuote) {
        const matchedEnd = allMatched ? open.length : failIdx;
        // Crucially, the line must match EVERY quote ancestor: if it
        // fails one (cm-251: '>>> foo\n> bar\n>>baz' — '>>baz' fails
        // the innermost quote), it is itself just a lazy continuation
        // of the paragraph in the deeper quote, not a new chunk.
        let q = -1;
        let allQuotesMatched = true;
        for (let k = 1; k < open.length - 1; k++) {
          if (open[k].t === 'quote') {
            q = k;
            if (k >= matchedEnd) allQuotesMatched = false;
          }
        }
        if (q !== -1 && allQuotesMatched && q < open.length - 2) {
          closeFrom(q + 1);
          li--;
          continue;
        }
      }
      let paraDone = false;
      if (allMatched) {
        const setextSt = saveCur();
        const lvl = matchSetext();
        if (lvl > 0) {
          // A paragraph whose first two lines form a table header +
          // delimiter is a TABLE, not a setext heading — marked's table
          // rule is tried before lheading, so the '=========' underline
          // itself becomes a table row. Re-read it as an ordinary
          // continuation line so finalize()'s tryTable() claims it.
          if (isTableStart(t.lines)) {
            restoreCur(setextSt);
          } else {
          // Strip link reference definitions first: they are not heading
          // content. If nothing remains, the paragraph vanishes and the
          // underline line itself becomes ordinary paragraph text.
          const text = t.lines.join('\n');
          const rest = stripLinkDefs(text, refs);
          if (rest.trim() === '') {
            removeFromParent(t);
            open.pop();
            restoreCur(setextSt); // re-read this line as a new block
            paraDone = true; // fall through to phase 3 for this line
          } else {
            const h = newNode('heading');
            h.level = lvl;
            h.text = rest;
            h.atx = false;
            replaceInParent(t, h);
            open.pop();
            finalize(h, refs);
            continue;
          }
          }
        }
      }
      if (!paraDone) {
        // A line that is the table delimiter row (or a body row of a
        // table-in-progress) does not interrupt the paragraph, even
        // when it starts with a list marker: '- | :-: | -----' is a
        // delimiter row, not a list item (marked tries table before
        // list for the paragraph's lines).
        if (allMatched) {
          const rest = curRest();
          // A line that starts an HTML block (types 1-6) is not a table
          // row, even when it contains '|': it ends the table and
          // starts the HTML block (inst1 doc-02: '<!-- note --> | fast
          // | ...' after a table header+delimiter is an HTML comment
          // block, not a body row). Type 7 (a complete tag alone on
          // the line) does not interrupt a paragraph, so it stays a row.
          let htmlStart = false;
          if (t.lines.length >= 2 && isTableStart(t.lines) && rest.includes('|')) {
            const hb = matchHtmlBlock();
            htmlStart = !!hb && hb.type !== 7;
          }
          if (!htmlStart &&
              ((t.lines.length === 1 && isTableStart([t.lines[0], rest])) ||
              (t.lines.length >= 2 && isTableStart(t.lines) && rest.includes('|')))) {
            t.lines.push(open.length > 2 ? expandParaTabs(rest, L.col) : rest);
            t.lastLazy = false;
            continue;
          }
        }
        // A lazy line (one that failed to match an open container)
        // starting an ordered list with a start number other than 1
        // ends the paragraph: the list starts at the outer level once
        // the container closes. interruptsPara() already handles
        // start-1 and bullets; start != 1 cannot interrupt a paragraph
        // directly, but it must not be absorbed as lazy text either
        // (inst0 doc-18, inst4 doc-06: '> para\n2. Author' becomes a
        // blockquote then '<ol start="2">'). Only when the paragraph
        // sits in a quote, not a list item (a list item's lazy line is
        // re-lexed inside the item and may be a nested list).
        let lazyListStart = false;
        if (!allMatched) {
          let hasItem = false;
          for (let j = failIdx + 1; j < open.length; j++) {
            if (open[j].t === 'item') { hasItem = true; break; }
          }
          if (!hasItem) {
            const lmSt = saveCur();
            const lm = matchListMarker();
            restoreCur(lmSt);
            lazyListStart = !!(lm && lm.ordered && lm.start !== 1);
          }
        }
        // marked's list lexer ends the item at ANY line starting with
        // ``` or ~~~ (fencesBeginRegex has no info-string check), even
        // when the line is not a valid fence — e.g. '```inner
        // backticks```' has a backtick in its info string, so
        // matchFence rejects it and interruptsPara() misses it, but
        // marked still ends the item there and the line becomes a new
        // paragraph outside the list. The check uses the item's content
        // indent R, clamped to n = max(0, min(3, R-1)) leading spaces
        // (marked's D() memoizer maps the factory argument R to
        // clamp(R-1, 0, 3)). Only when the line failed that item's
        // match (a properly indented line stays item content).
        const fenceBeginBreaksItem = () => {
          if (allMatched || failIdx < 1) return false;
          const nd = open[failIdx];
          if (!nd || nd.t !== 'item') return false;
          const R = nd.contentIndent || 0;
          const n = Math.max(0, Math.min(3, R - 1));
          const rest = L.s.slice(L.pos);
          let i = 0;
          while (i < rest.length && rest.charCodeAt(i) === 32) i++;
          if (i > n) return false;
          const c = i < rest.length ? rest.charCodeAt(i) : -1;
          if (c !== 96 && c !== 126) return false;
          let j = i;
          while (j < rest.length && rest.charCodeAt(j) === c) j++;
          return j - i >= 3;
        };
        // marked's list lexer ends an item at a lazy line when the
        // previous line of the item text is indented 4+ columns (it
        // was absorbed as indented code): 'm.search(nonSpaceChar)
        // >= 4' with tabs counted as 4 spaces each. E.g. '- a\n
        // indented six\nlazy line' — the lazy line becomes a
        // top-level paragraph and the item ends. A previous line
        // indented < 4 (3 spaces, e.g. '     indented four') keeps
        // the lazy line inside the item (inst1 doc-11).
        const lazyAfterCodeBreaksItem = () => {
          if (allMatched || failIdx < 1) return false;
          const nd = open[failIdx];
          if (!nd || nd.t !== 'item') return false;
          // marked's check measures m = Z.slice(R) — the previous
          // line with the item's content indent R stripped. For a
          // LAZY previous line, Z has fewer than R leading spaces,
          // so slicing R eats into the text and m starts with a
          // non-space (indent 0) — the check never fires after a
          // lazy line. Only a normal continuation line (lastLazy
          // false) can leave m indented 4+.
          if (t.lastLazy) return false;
          const last = t.lines[t.lines.length - 1];
          if (last === undefined) return false;
          const expanded = last.replace(/\t/g, '    ');
          let i = 0;
          while (i < expanded.length && expanded.charCodeAt(i) === 32) i++;
          return i >= 4;
        };
        if (interruptsPara() || lazyListStart || fenceBeginBreaksItem() || lazyAfterCodeBreaksItem()) {
          closeFrom(allMatched ? open.length - 1 : failIdx);
          // fall through to phase 3
        } else if (!allMatched) {
          // Whether this lazy line left the innermost block quote
          // containing the paragraph: it failed at or before that
          // quote (failIdx <= its index), so it never entered the
          // quote's chunk. A lazy line that matched the quote and
          // only failed an inner list/item (T4: '> continuation'
          // inside a quote) is lazy text WITHIN the chunk and does
          // not end it. Used by the blockquote chunk-close check.
          {
            let qIn = -1;
            for (let k = 1; k < open.length - 1; k++) if (open[k].t === 'quote') qIn = k;
            t.lastLazyQuote = qIn !== -1 && failIdx <= qIn;
          }
          // Lazy continuation: the line failed to match an open
          // container. marked re-lexes such lines inside their list
          // item (or quote chunk), so the line is read after the
          // content indents of the list items between the failing
          // container and this paragraph (each stripped only when the
          // line carries that many columns); then:
          // - a setext-looking line properly indented for its item is
          //   a real setext underline (heading);
          // - a setext-looking line lazy inside a quote gets 4 spaces
          //   prepended instead of becoming a heading (cm-093);
          // - a setext-looking line lazy for its item stays paragraph
          //   text with its indent stripped;
          // - other lazy lines keep their leading whitespace, except
          //   a first lazy line of a quote chunk indented 4+ columns
          //   is indented-code text (its trailing newline becomes a
          //   blank line before the next paragraph line).
          let strippedAll = true;
          let hasItem = false;
          // Start at the failing container itself, not after it: when
          // the failing container IS the item (a lazy line under
          // indented for it, e.g. 7 spaces against R=8), the paragraph
          // is still inside that item, so the line is item content
          // that keeps its leading whitespace — it must NOT take the
          // no-item branch below (first lazy line of a quote chunk,
          // which strips 4 columns as indented code). Starting here
          // also makes skipCols fail on that item, so strippedAll is
          // false, as the line does not carry the item's indent.
          for (let j = failIdx; j < open.length; j++) {
            const nd = open[j];
            if (nd.t !== 'item') continue;
            hasItem = true;
            if (!skipCols(nd.contentIndent)) { strippedAll = false; break; }
          }
          const line = curRest();
          const lineCol = L.col;
          const setextM = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
          if (!hasItem) {
            if (!t.lastLazy) {
              // first lazy line of the chunk: try a 4-column code strip
              const st = saveCur();
              if (advanceCols(4)) {
                t.lines.push(curRest());
                t.lazyCode = true;
                t.lastLazy = true;
                continue;
              }
              restoreCur(st);
            } else if (t.lazyCode) {
              const st = saveCur();
              if (advanceCols(4)) {
                t.lines[t.lines.length - 1] += '\n' + curRest();
                t.lastLazy = true;
                continue;
              }
              restoreCur(st);
              // the code run ends: its trailing newline becomes a blank line
              t.lines[t.lines.length - 1] += '\n';
              t.lazyCode = false;
            }
          }
          if (setextM && hasItem && strippedAll) {
            // real setext underline for the list item's paragraph
            const lvl = setextM[1].charCodeAt(0) === 61 ? 1 : 2;
            const text = t.lines.join('\n');
            const rest = stripLinkDefs(text, refs);
            if (rest.trim() !== '') {
              const h = newNode('heading');
              h.level = lvl; h.text = rest; h.atx = false;
              replaceInParent(t, h);
              open.pop();
              finalize(h, refs);
              continue;
            }
            t.lines.push(line.replace(/^[ \t]+/, ''));
            t.lastLazy = true;
            continue;
          }
          if (setextM && !hasItem) {
            // lazy inside a quote (no list item between): 4-space hack
            t.lines.push('    ' + line.replace(/^[ \t]+/, ''));
            t.lastLazy = true;
            continue;
          }
          if (setextM) {
            // lazy for its list item: paragraph text, indent stripped
            t.lines.push(line.replace(/^[ \t]+/, ''));
            t.lastLazy = true;
            continue;
          }
          t.lines.push(inItem ? expandParaTabs(line, lineCol) : line);
          t.lastLazy = true;
          continue;
        } else {
          // Normal continuation: flush a lazy code run first, then
          // keep the rest of the line as-is (expanding a leading tab
          // to spaces on the virtual column — but only inside a
          // container; at the top level marked keeps a leading tab
          // literal in a paragraph line).
          if (t.lazyCode) {
            t.lines[t.lines.length - 1] += '\n';
            t.lazyCode = false;
          }
          t.lines.push(open.length > 2 ? expandParaTabs(curRest(), L.col) : curRest());
          t.lastLazy = false;
          t.lastLazyQuote = false;
          continue;
        }
      }
    } else if (t.t === 'fence') {
      if (allMatched) {
        if (matchFenceClose(t.ch, t.len)) { closeFrom(open.length - 1); continue; }
        // Top level: strip the fence indent as whitespace characters
        // (marked's Dt compensation), keeping tabs unless the indent
        // straddles them. Inside a container the leading tab expands
        // on the absolute column.
        const fl = L.col === 0
          ? stripFenceChars(curRest(), t.indent || 0)
          : fenceContentLine(curRest(), L.col, t.fenceCol || 0);
        t.lines.push(fl);
        // A content line starting with a run of the fence char (3+,
        // e.g. '```inner backticks```') ends lazy continuation:
        // marked's list lexer treats it as a fence boundary, so the
        // next non-indented line ends the fence/item instead of
        // continuing it (inst2 doc-34). The threshold is 3 (the
        // minimum fence length), not the fence's own length.
        t.lastBt = startsFenceRun(fl, t.ch, 3);
        continue;
      }
      // Lazy fence content: a non-blank line that does not match its
      // container is still fence content ONLY when the fence already
      // has a content line (a continuation) and the failing container
      // is a list item. The FIRST content line must match the
      // container: a non-indented first line ends the list item and
      // leaves the fence empty (marked: `- item` + fence + `print()`
      // at column 0). A blank line, or a line failing a blockquote,
      // closes the fence instead. A lazy line is kept verbatim (no
      // fence-indent strip): it never went through container stripping.
      {
        const raw = L.s;
        let blank = true;
        for (let k = 0; k < raw.length; k++) {
          const c = raw.charCodeAt(k);
          if (c !== 32 && c !== 9) { blank = false; break; }
        }
        const failNode = open[failIdx];
        // A quote between the failing container and the fence also
        // blocks lazy content: the line fails an outer container, so
        // it is outside that quote (marked's blockquote chunks end at
        // a non-'>' line), and a line outside a quote cannot be
        // content of a fence inside it (doc-36: a new list item line
        // with no '>' was swallowed into a ~~~ fence in a quote).
        let quoteBetween = false;
        for (let k = failIdx + 1; k < open.length - 1; k++) {
          if (open[k].t === 'quote') { quoteBetween = true; break; }
        }
        // A lazy line must directly continue the fence: after a blank
        // line a non-indented line is no longer part of the list item
        // (its content must be re-indented), so the item and its fence
        // end instead — e.g. inst3 doc-35: a ```markdown fence in a
        // list item whose content hits a blank line, then
        // 'npm install...' at column 0, closes the fence there. A
        // content line starting with a fence-char run also ends lazy
        // continuation (see startsFenceRun above).
        const prevBlank = t.lines.length > 0 && t.lines[t.lines.length - 1].trim() === '';
        // A lazy line must be indented to at least its item's startCol
        // (the parent container's content start): a line less indented
        // than that is outside the list item entirely, so it ends the
        // item and its fence (inst1 doc-38: a ```text fence in a nested
        // list item whose content hits 'html src/index.ts invalid' at
        // column 0 closes there). A line at column 0 inside a top-level
        // list (startCol 0) IS lazy fence content (practice doc-02:
        // 'function f(a, b) {' at column 0 inside a ```css fence).
        let failItem = null;
        for (let k = open.length - 1; k >= 0; k--) {
          if (open[k].t === 'item') { failItem = open[k]; break; }
        }
        let rawIndent = 0;
        {
          let sp = 0;
          while (sp < raw.length) {
            const cc = raw.charCodeAt(sp);
            if (cc === 32) { rawIndent++; sp++; }
            else if (cc === 9) { rawIndent += 4 - (rawIndent & 3); sp++; }
            else break;
          }
        }
        const indentOk = !failItem || rawIndent >= (failItem.startCol || 0);
        // marked's list lexer also breaks when the previous line (in the
        // item text) starts a block: a fence-content line like
        // '# not a heading' matches the heading regex, so a following
        // under-indented line is a new block outside the item, not a
        // lazy continuation (inst1 doc-38).
        const prevLine = t.lines.length > 0 ? t.lines[t.lines.length - 1] : '';
        const prevIsBlockStart = /^(?:#{1,6}(?:[ \t]|$)|<[A-Za-z!/?]|(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})/.test(prevLine);
        // A fence content line indented 4+ columns past the item's
        // content start looks like an indented code block to marked's
        // list lexer, and it breaks lazy continuation: the next
        // non-indented line ends the item (and its fence) instead of
        // continuing it (inst4 doc-06: '    indented four' after the
        // ```console fence in item 8, so the column-0
        // 'print("hello, world")' ends the item). The stored content
        // line already had the fence indent stripped, so its indent
        // past the item content start is t.indent + its own leading
        // whitespace width.
        let prevIndent = t.indent || 0;
        {
          let p = 0;
          while (p < prevLine.length) {
            const cc = prevLine.charCodeAt(p);
            if (cc === 32) { prevIndent++; p++; }
            else if (cc === 9) { prevIndent += 4 - (prevIndent & 3); p++; }
            else break;
          }
        }
        const prevIsIndentedCode = prevIndent >= 4;
        const lazyOk = indentOk && !prevIsBlockStart && !prevIsIndentedCode && !blank && !prevBlank && !t.lastBt && t.lines.length > 0 && failNode && (failNode.t === 'item' || failNode.t === 'list') && !quoteBetween;
        if (!lazyOk) { closeFrom(failIdx); /* fall through: re-process line */ }
        else {
          let p = 0;
          while (p < raw.length && raw.charCodeAt(p) === 32 && p < 3) p++;
          let q = p, run = 0;
          while (q < raw.length && raw.charCodeAt(q) === t.ch) { q++; run++; }
          let r = q;
          while (r < raw.length && (raw.charCodeAt(r) === 32 || raw.charCodeAt(r) === 9)) r++;
          if (run >= t.len && r === raw.length) { closeFrom(open.length - 1); continue; }
          t.lines.push(raw);
          t.lastBt = startsFenceRun(raw, t.ch, 3);
          continue;
        }
      }
    } else if (t.t === 'code') {
      if (allMatched) {
        if (restBlank) { t.lines.push(stripIndent(curRest(), 4)); continue; }
        const codeSt = saveCur();
        if (advanceCols(4)) { t.lines.push(curRest()); continue; }
        // line is not indented enough: restore the cursor (advanceCols
        // mutates it even on failure), close the code block, fall to phase 3
        restoreCur(codeSt);
        closeFrom(open.length - 1);
      } else {
        closeFrom(failIdx);
      }
    } else if (t.t === 'html') {
      if (allMatched) {
        if (t.htmlType <= 5) {
          // types 1-5 end at a line containing the end string (blank lines
          // are content); the end line is included in the block
          // Inside a container (list item / quote) marked's item text
          // has leading tabs already expanded to spaces on the absolute
          // column (inst0 doc-25: '\t\tindented...' in an item becomes
          // 5 spaces); expand them here too so the raw html matches.
          const line = open.length > 2 ? expandParaTabs(curRest(), L.col) : curRest();
          t.lines.push(line);
          t.lastLineIdx = li;
          if (htmlEndsOnLine(t.htmlType, t.htmlTag, line)) closeFrom(open.length - 1);
          continue;
        }
        // types 6-7 end at a blank line
        if (restBlank) { const pIsItem = t.parent && t.parent.t === 'item'; closeFrom(open.length - 1); if (blank || pIsItem) blankPending = true; continue; }
        t.lines.push(open.length > 2 ? expandParaTabs(curRest(), L.col) : curRest());
        t.lastLineIdx = li;
        continue;
      }
      closeFrom(failIdx);
    } else if (failIdx >= 0) {
      // tip is a container that did not match: close it and everything below
      closeFrom(failIdx);
    }

    // Phase 3: new block starts (tip is a container)
    let startedOnLine = false;
    while (true) {
      const cur = tip();
      if (curIsBlank()) {
        // an empty list item ends at a blank line: following indented
        // content belongs to the enclosing block, not the item. Only on
        // a fresh blank line (not the line that just opened the item).
        if (!startedOnLine) {
          while (tip().t === 'item' && tip().children.length === 0) {
            closeFrom(open.length - 1);
          }
          blankPending = true;
        }
        break;
      }
      // a list can only contain items: if the tip is a list and this line
      // does not start an item of the same list, the list ends here
      if (cur.t === 'list') {
        const listSt = saveCur();
        // a thematic break closes the list (it is not a list item)
        if (matchHr()) {
          restoreCur(listSt);
          closeFrom(open.length - 1);
          continue; // re-run phase 3 with the new tip; the hr is matched below
        }
        restoreCur(listSt);
        const lm0 = matchListMarker();
        if (lm0) {
          const same = cur.ordered === lm0.ordered &&
            (lm0.ordered ? cur.delim === lm0.delim : cur.bullet === lm0.bullet);
          if (same) {
            if (blankPending && cur.children.length > 0) cur.loose = true;
            blankPending = false;
            const ci = markerContentIndent(lm0);
            const item = newNode('item');
            item.contentIndent = ci;
            // absolute column of the item's content start (startCol is
            // the parent container's content start; ci is relative to
            // it). fixHtml compares the next line's indent in absolute
            // columns, so it needs this, not the relative ci.
            item.startCol = lm0.startCol;
            addChild(cur, item);
            open.push(item);
            startedOnLine = true;
            continue; // process the item's content on this line
          }
        }
        // different (or no) marker: restore the cursor (matchListMarker
        // advanced past the marker) so the re-run can start a new list
        restoreCur(listSt);
        closeFrom(open.length - 1);
        continue; // re-run phase 3 with the new tip
      }
      if (matchQuote()) {
        noteBlockStart();
        const q = newNode('quote');
        addChild(cur, q);
        open.push(q);
        blankPending = false;
        startedOnLine = true;
        continue; // process the quote's content on this line
      }
      const atx = matchAtx();
      if (atx) {
        noteBlockStart();
        const h = newNode('heading');
        h.level = atx.level;
        h.text = atx.content;
        h.atx = true;
        addChild(cur, h);
        finalize(h, refs);
        startedOnLine = true;
        break;
      }
      if (matchHr()) {
        noteBlockStart();
        addChild(cur, newNode('hr'));
        startedOnLine = true;
        break;
      }
      const f = matchFence();
      if (f) {
        noteBlockStart();
        const info = curRest();
        const fn = newNode('fence');
        fn.ch = f.ch;
        fn.len = f.len;
        // marked quirk: a tilde fence (~~~) does NOT strip the fence
        // indent from its content lines — only backtick fences do.
        // (verified: '   ~~~\n   content\n   ~~~' keeps the 3 spaces in
        // marked, while '   ```\n   content\n   ```' strips them.)
        fn.indent = f.ch === 126 ? 0 : f.indent;
        fn.fenceCol = f.ch === 126 ? 0 : f.fenceCol;
        fn.lines = [];
        // language = first word of the info string
        const trimmed = info.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
        let end = trimmed.length;
        for (let p = 0; p < trimmed.length; p++) {
          const cc = trimmed.charCodeAt(p);
          if (cc === 32 || cc === 9) { end = p; break; }
        }
        fn.lang = resolveEscapes(trimmed.slice(0, end));
        addChild(cur, fn);
        open.push(fn);
        startedOnLine = true;
        break;
      }
      const hb = matchHtmlBlock();
      if (hb) {
        noteBlockStart();
        const hn = newNode('html');
        hn.htmlType = hb.type;
        hn.htmlTag = hb.tag;
        const firstLine = curRest();
        hn.lines = [firstLine];
        hn.lastLineIdx = li;
        addChild(cur, hn);
        // types 1-5 may already end on their first line (e.g. <!-- -->)
        if (!(hb.type <= 5 && htmlEndsOnLine(hb.type, hb.tag, firstLine))) {
          open.push(hn);
        }
        startedOnLine = true;
        break;
      }
      const lm = matchListMarker();
      if (lm) {
        // start a new list (the tip is not a list; that case is handled at
        // the top of this loop)
        noteBlockStart();
        const list = newNode('list');
        list.ordered = lm.ordered;
        list.delim = lm.delim;
        list.bullet = lm.bullet;
        list.start = lm.start;
        list.loose = false;
        addChild(cur, list);
        open.push(list);
        blankPending = false;
        const ci = markerContentIndent(lm);
        const item = newNode('item');
        item.contentIndent = ci;
        item.startCol = lm.startCol;
        addChild(list, item);
        open.push(item);
        startedOnLine = true;
        continue; // process the item's content on this line
      }
      if (matchIndentedCode()) {
        noteBlockStart();
        const cn = newNode('code');
        cn.lines = [curRest()];
        addChild(cur, cn);
        open.push(cn);
        startedOnLine = true;
        break;
      }
      // plain paragraph. A leading tab on the first line expands to
      // spaces on the virtual column when the paragraph is inside a
      // container (open holds root + containers here, the para not yet
      // pushed, so the test is open.length > 1): the line passed
      // through a container marker, and marked expands the whitespace
      // after '>' (blockquoteMarkerWhitespace + J) and after a list
      // marker. At the top level marked keeps a leading tab literal.
      // (Lazy continuation lines are different — see inItem above.)
      noteBlockStart();
      const p = newNode('para');
      p.lines = [open.length > 1 ? expandParaTabs(curRest(), L.col) : curRest()];
      p.lastLazy = false;
      p.lazyCode = false;
      addChild(cur, p);
      open.push(p);
      blankPending = false;
      startedOnLine = true;
      break;
    }
  }

  closeFrom(1);
  return root;
}

// --- renderer ---

const CHECKBOX_UNCHECKED = '<input disabled="" type="checkbox">';
const CHECKBOX_CHECKED = '<input checked="" disabled="" type="checkbox">';

// Strip trailing whitespace from the last paragraph in a node's
// subtree, in document order (the last paragraph anywhere under the
// node, not only on the last-child chain — a paragraph can be the
// last text block of an item even when a nested list follows it in
// the child array). Marked trims the trailing whitespace of the last
// paragraph inside the last list item (at any depth); a top-level
// paragraph or blockquote keeps it.
function stripLastParaTrailing(node) {
  // Marked trims the trailing whitespace of the last paragraph inside
  // the last list item (at any depth) — but only when that paragraph
  // is the item's last TEXT block. A nested list after it is fine
  // (the paragraph is still the last text), but an html block, fence,
  // code block, heading, hr, quote or table after it means the
  // paragraph is not last, and its trailing spaces are kept
  // (inst0 doc-37: a paragraph ending '--.  ' followed by an
  // '<!-- note -->' html block in the same item keeps the two spaces).
  let last = null;
  let afterText = false;
  const walk = (n) => {
    if (!n) return;
    if (n.t === 'para') { last = n; afterText = false; }
    else if (n.t === 'html' || n.t === 'fence' || n.t === 'code' || n.t === 'heading' || n.t === 'hr' || n.t === 'quote' || n.t === 'table') afterText = true;
    if (n.children) for (const c of n.children) walk(c);
  };
  walk(node);
  if (last && !afterText) last.text = last.text.replace(/[ \t]+$/, '');
}

function renderItem(node, refs, out, isLast) {
  out.push('<li>');
  const tight = !node.parent.loose;
  const children = node.children;
  if (isLast) stripLastParaTrailing(node);
  for (let k = 0; k < children.length; k++) {
    const ch = children[k];
    if (ch.t === 'para') {
      let text = ch.text;
      let box = null;
      if (k === 0 && text.length >= 4 && text.charCodeAt(0) === 91) {
        const c1 = text.charCodeAt(1);
        if ((c1 === 32 || c1 === 120 || c1 === 88) &&
            text.charCodeAt(2) === 93 && text.charCodeAt(3) === 32) {
          box = c1 === 32 ? CHECKBOX_UNCHECKED : CHECKBOX_CHECKED;
          // keep the space after ']' in the rendered text
          text = text.slice(3);
        }
      }
      // marked strips trailing whitespace from the LAST item's paragraph
      // text only (a top-level <p> and non-last items keep it); the
      // subtree helper above handles it (last paragraph at any depth).
      if (tight) {
        if (box) out.push(box);
        inlineTo(text, refs, out);
      } else {
        out.push('<p>');
        if (box) out.push(box);
        inlineTo(text, refs, out);
        out.push('</p>\n');
      }
    } else {
      renderBlocks(ch, refs, out);
    }
  }
  out.push('</li>\n');
}

function renderBlocks(node, refs, out) {
  switch (node.t) {
    case 'doc':
      for (const ch of node.children) renderBlocks(ch, refs, out);
      break;
    case 'para':
      out.push('<p>');
      inlineTo(node.text, refs, out);
      out.push('</p>\n');
      break;
    case 'heading':
      out.push('<h', node.level, '>');
      inlineTo(node.text, refs, out);
      out.push('</h', node.level, '>\n');
      break;
    case 'code':
      out.push('<pre><code>');
      for (const line of node.lines) { out.push(escapeStr(line)); out.push('\n'); }
      out.push('</code></pre>\n');
      break;
    case 'fence':
      out.push('<pre><code');
      if (node.lang) { out.push(' class="language-', escapeNoEncodeStr(node.lang), '"'); }
      out.push('>');
      for (const line of node.lines) { out.push(escapeStr(line)); out.push('\n'); }
      out.push('</code></pre>\n');
      break;
    case 'html': {
      out.push(node.lines.join('\n'));
      // Trailing newline (computed in parse()): present iff the line after
      // the block's last line is non-blank, or the block runs to the end
      // of the input and the input ends with a newline.
      if (node.trailingNL) out.push('\n');
      break;
    }
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const ch of node.children) renderBlocks(ch, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list':
      out.push(node.ordered ? '<ol' : '<ul');
      if (node.ordered && node.start !== 1) out.push(' start="', node.start, '"');
      out.push('>\n');
      for (let k = 0; k < node.children.length; k++) renderItem(node.children[k], refs, out, k === node.children.length - 1);
      out.push(node.ordered ? '</ol>\n' : '</ul>\n');
      break;
    case 'item':
      renderItem(node, refs, out);
      break;
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let k = 0; k < node.header.length; k++) {
        const a = node.align[k];
        out.push('<th');
        if (a) out.push(' align="', a, '"');
        out.push('>');
        inlineTo(node.header[k], refs, out);
        out.push('</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (node.rows.length > 0) {
        out.push('<tbody>');
        for (const row of node.rows) {
          out.push('<tr>\n');
          for (let k = 0; k < row.length; k++) {
            const a = node.align[k];
            out.push('<td');
            if (a) out.push(' align="', a, '"');
            out.push('>');
            inlineTo(row[k], refs, out);
            out.push('</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody></table>\n');
      } else {
        out.push('</table>\n');
      }
      break;
    }
  }
}

// --- entry point ---

// The HTML marked 18.1.3 renders for `markdown`, with marked's defaults
// (GFM on, breaks off, pedantic off, async off).
export function parse(markdown) {
  docInLink = false;
  let s = markdown;
  if (s.indexOf('\r') !== -1) s = s.replace(/\r\n?/g, '\n');
  const lines = s.split('\n');
  // A trailing newline does not create an extra (blank) line.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const refs = new Map();
  const root = parseBlocks(lines, refs);
  root.inputEndsWithNL = s.endsWith('\n');
  // HTML blocks: a trailing newline is emitted iff the line after the
  // block's last line is non-blank AND in the same container as the block,
  // or (top-level only) the block runs to the end of the input and the
  // input ends with a newline. A nested block whose container ends (new
  // list item, line outside its quote, EOF) gets no trailing newline.
  const isBlankLine = (ln) => {
    for (let k = 0; k < ln.length; k++) {
      const c = ln.charCodeAt(k);
      if (c !== 32 && c !== 9) return false;
    }
    return true;
  };
  // Absolute indent column of a line: strip enclosing quote markers
  // (a '>' plus one following space) tracking the stripped width W,
  // then count the leading indent. Tabs advance to the next multiple
  // of 4 in absolute columns.
  const absIndent = (ln) => {
    let nx = ln, W = 0;
    for (;;) {
      let q = 0, wq = 0;
      while (q < nx.length) {
        const cc = nx.charCodeAt(q);
        if (cc === 32) { wq++; q++; }
        else if (cc === 9) { wq += 4 - ((W + wq) & 3); q++; }
        else break;
      }
      if (nx.charCodeAt(q) !== 62) break;
      q++; wq++;
      if (nx.charCodeAt(q) === 32) { q++; wq++; }
      else if (nx.charCodeAt(q) === 9) { wq += 4 - ((W + wq) & 3); q++; }
      W += wq;
      nx = nx.slice(q);
    }
    let col = 0, sp = 0;
    while (sp < nx.length) {
      const cc = nx.charCodeAt(sp);
      if (cc === 32) { col++; sp++; }
      else if (cc === 9) { col += 4 - ((W + col) & 3); sp++; }
      else break;
    }
    return W + col;
  };
  const fixHtml = (node) => {
    if (node.t === 'html') {
      let trailing = false;
      const topLevel = node.parent && node.parent.t === 'doc';
      if (node.lastLineIdx >= lines.length - 1) {
        trailing = topLevel && root.inputEndsWithNL;
      } else {
        const next = lines[node.lastLineIdx + 1];
        // marked's ge(): the block keeps a trailing newline iff the
        // matched text ends with exactly one '\n' after the last
        // content line. For types 1-5 the regex only captures a run of
        // '\n's, so a whitespace-only next line (spaces/tabs) breaks
        // the run and the newline is kept; only a truly empty next
        // line extends the run and drops it. For types 6-7 the regex
        // consumes blank lines (incl. whitespace-only) as part of the
        // block, so the newline is kept only when the next line is
        // non-blank — judged after stripping the parent container
        // marker, so a bare '>' line inside a quote counts as blank
        // (inst2 doc-25: a type-6 <div> block ending in '~~~' has no
        // trailing newline before the next paragraph).
        const par0 = node.parent;
        let nextBlank = isBlankLine(next);
        if (par0 && par0.t === 'quote') {
          // Strip one '>' marker per enclosing quote level. The next
          // line is blank for this quote iff nothing but markers and
          // spaces remain after stripping: a bare '> >' line in a
          // nested quote is blank for the inner quote (the old code
          // stripped only one marker, so '> >' was misread as
          // content and a type-6 HTML block wrongly kept a trailing
          // newline — fresh inst0 doc-06, fresh2 inst3 doc-12).
          // Count ALL quote ancestors, not just consecutive ones:
          // an outer quote can be an ancestor through list items
          // (fresh inst0 doc-06: the inner quote sits inside a list
          // inside the outer quote, yet the line still carries both
          // markers), so the marker count is the total quote depth.
          let depth = 0;
          for (let p = par0; p; p = p.parent) if (p.t === 'quote') depth++;
          let rest = next;
          for (let d = 0; d < depth; d++) {
            let q = 0;
            while (q < rest.length && (rest.charCodeAt(q) === 32 || rest.charCodeAt(q) === 9)) q++;
            if (rest.charCodeAt(q) !== 62) break;
            q++;
            if (rest.charCodeAt(q) === 32 || rest.charCodeAt(q) === 9) q++;
            rest = rest.slice(q);
          }
          nextBlank = isBlankLine(rest);
        }
        const hasNext = node.htmlType <= 5
          ? (topLevel ? next.length > 0 : !nextBlank)
          : !nextBlank;
        if (hasNext) {
          if (topLevel) trailing = true;
          else {
            // nested: the next line must continue the immediate parent
            // container (quote: starts with '>'; item: indented to the
            // item's content indent)
            const par = node.parent;
            if (par && par.t === 'quote') {
              trailing = next.trimStart().startsWith('>');
            } else if (par && par.t === 'item') {
              // Compare the next line's absolute indent against the
              // item's absolute content column (startCol +
              // contentIndent). The old code compared the stripped
              // indent against the relative contentIndent, which is
              // only correct for top-level items (startCol 0) or
              // items in a quote (where the stripped '>' width equals
              // startCol); for nested list items it wrongly treated a
              // sibling item marker as a continuation (inst1 doc-04).
              trailing = absIndent(next) >= ((par.startCol || 0) + (par.contentIndent || 0));
            }
          }
        } else if (!topLevel && node.parent && node.parent.t === 'item' && node.htmlType <= 5) {
          // Blank line after the block (types 1-5): the item text
          // ends at the block's line, so the newline is kept — unless
          // the blank line is followed by a nested block inside the
          // item (then the blank line is part of the item and the
          // match swallows two newlines), or the item is the last
          // item (marked trimEnds its text). Look past the blank
          // lines: a following line indented to the item's content
          // column (or more) is a nested block (no trailing newline);
          // a less-indented line is outside the item (keep it).
          const item = node.parent;
          const list = item.parent;
          const isLastItem = list && list.children && list.children[list.children.length - 1] === item;
          if (isLastItem) {
            trailing = false;
          } else {
            const absContent = (item.startCol || 0) + (item.contentIndent || 0);
            let j = node.lastLineIdx + 1;
            while (j < lines.length && isBlankLine(lines[j])) j++;
            trailing = j < lines.length && absIndent(lines[j]) < absContent;
          }
        }
      }
      node.trailingNL = trailing;
    }
    if (node.children) for (const ch of node.children) fixHtml(ch);
  };
  fixHtml(root);
  const out = [];
  renderBlocks(root, refs, out);
  return out.join('');
}
