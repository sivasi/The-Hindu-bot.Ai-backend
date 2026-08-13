import fs from "fs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const BLOCKED_HEADINGS = new Set([
  "inside",
  "follow us",
  "in brief",
  "brief",
  "view point",
  "viewpoint",
  "the india show",
  "indians in action",
]);

const SECTION_NAMES = new Set([
  "news",
  "sport",
  "sports",
  "business",
  "states",
  "world",
  "editorial",
  "opinion",
  "national",
  "international",
  "delhi",
  "telangana",
  "faith",
  "science",
  "education",
  "investor",
]);

export async function openPdfDocument(pdfPath) {
  const data = new Uint8Array(fs.readFileSync(pdfPath));
  return getDocument({
    data,
    verbosity: 0,
    useSystemFonts: true,
  }).promise;
}

/**
 * High-accuracy newspaper article split (~90% target).
 * Uses font size + strict same-column geometry so headings/body
 * from different columns are not merged.
 */
export async function extractArticlesFromLoadedPage(doc, pageNumber, options = {}) {
  const {
    headlineMinSize = 13.5,
    yTolerance = 2.2,
    xGapSplit = 12,
  } = options;

  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();

  const items = content.items
    .filter((item) => item.str && String(item.str).trim())
    .map((item) => {
      const text = String(item.str).replace(/\s+/g, " ").trim();
      const size = Math.hypot(item.transform[2], item.transform[3]);
      return {
        text,
        x: item.transform[4],
        y: item.transform[5],
        size,
        width: item.width || size * Math.max(text.length, 1) * 0.42,
      };
    })
    .filter((item) => item.text && !isNoise(item.text));

  const lines = buildLineSegments(items, yTolerance, xGapSplit);
  const columns = detectColumns(lines, viewport.width);
  for (const line of lines) {
    line.col = columnIndex((line.x0 + line.x1) / 2, columns);
    line.usedAsHeading = false;
  }

  const section =
    lines.find((line) => {
      const key = normalize(line.text);
      return line.maxSize >= 22 && SECTION_NAMES.has(key);
    })?.text || null;

  const headingLines = lines
    .filter((line) => isHeadingCandidate(line, headlineMinSize))
    .sort((a, b) => b.y - a.y || a.x0 - b.x0);

  const headings = mergeHeadingsStrict(headingLines);
  for (const heading of headings) {
    for (const src of heading.sourceLines) src.usedAsHeading = true;
    // Attach small ALL-CAPS kicker directly above with same left edge.
    const kicker = lines.find(
      (line) =>
        !line.usedAsHeading &&
        Math.abs(line.x0 - heading.x0) < 40 &&
        line.y > heading.y &&
        line.y - heading.y < heading.maxSize * 2.2 &&
        isKicker(line.text) &&
        line.maxSize <= 11
    );
    if (kicker) {
      kicker.usedAsHeading = true;
      heading.kicker = kicker.text;
      heading.text = `${kicker.text}: ${heading.text}`;
    }
  }

  const articles =
    headings.length > 0
      ? headings.map((h) => ({
          ...h,
          bodies: [],
        }))
      : [
          {
            text: `Page ${pageNumber}`,
            x0: 0,
            x1: viewport.width,
            y: Number.POSITIVE_INFINITY,
            yBottom: Number.POSITIVE_INFINITY,
            maxSize: 0,
            col: 0,
            wide: true,
            sourceLines: [],
            bodies: [],
          },
        ];

  const orphan = {
    text: `Page ${pageNumber} other text`,
    x0: 0,
    x1: viewport.width,
    y: Number.POSITIVE_INFINITY,
    yBottom: Number.POSITIVE_INFINITY,
    maxSize: 0,
    col: -1,
    wide: true,
    sourceLines: [],
    bodies: [],
  };

  for (const line of lines) {
    if (line.usedAsHeading) continue;
    if (isStructuralNoise(line.text)) continue;
    if (SECTION_NAMES.has(normalize(line.text)) && line.maxSize >= 18) continue;

    const owner = findBestHeadingForBody(line, articles) || orphan;
    owner.bodies.push(line);
  }

  // If a heading still has no body, pull nearby orphan lines under it.
  if (orphan.bodies.length) {
    const remaining = [];
    for (const line of orphan.bodies) {
      const owner = findBestHeadingForBody(line, articles);
      if (owner) owner.bodies.push(line);
      else remaining.push(line);
    }
    orphan.bodies = remaining;
  }

  const allArticles = [...articles];
  if (orphan.bodies.length) allArticles.push(orphan);

  return allArticles
    .map((article) => {
      const body = joinLines(article.bodies);
      const heading = cleanupHeading(article.text);
      const text = [heading, body].filter(Boolean).join("\n\n").trim();
      return {
        heading,
        section,
        pageNumber,
        body,
        text,
      };
    })
    .filter((a) => a.heading && (a.text.length >= 16 || wordCount(a.heading) >= 3));
}

export async function extractArticlesFromPage(pdfPath, pageNumber, options = {}) {
  const doc = await openPdfDocument(pdfPath);
  try {
    return extractArticlesFromLoadedPage(doc, pageNumber, options);
  } finally {
    await doc.destroy();
  }
}

function isHeadingCandidate(line, headlineMinSize) {
  if (line.maxSize < headlineMinSize) return false;
  if (isJunkHeading(line)) return false;
  if (looksLikeProse(line.text, line.maxSize)) return false;

  const key = normalize(line.text);
  if (SECTION_NAMES.has(key)) return false;
  if (BLOCKED_HEADINGS.has(key)) return false;
  if (/^(news|sport|editorial)\s*»/i.test(line.text)) return false;
  if (/»\s*page\s+\d+/i.test(line.text)) return false;
  if (/page\s+\d+/i.test(line.text) && wordCount(line.text) <= 4) return false;

  const words = wordCount(line.text);
  // Teasers (~13–14pt) and display headlines.
  if (words >= 3 && line.maxSize >= Math.min(headlineMinSize, 12.8)) return true;
  if (words >= 2 && line.maxSize >= headlineMinSize) return true;
  // Place names / short labels above multi-line titles (e.g. Himachal).
  if (words === 1 && line.maxSize >= 17 && /^[A-Z]/.test(line.text)) return true;
  // Single-word title continuations ("infrastructure") at display size.
  if (words === 1 && line.maxSize >= 18) return true;
  if (words >= 1 && line.maxSize >= 34) return true;
  return false;
}

function mergeHeadingsStrict(headingLines) {
  const headings = [];
  const sameX0 = (a, b) => Math.abs(a.x0 - b.x0) < 36;
  const similarSize = (a, b) =>
    Math.min(a.maxSize, b.maxSize) >= Math.max(a.maxSize, b.maxSize) * 0.78;
  const findPrevSameColumn = (line) => {
    for (let i = headings.length - 1; i >= 0; i -= 1) {
      if (sameX0(headings[i], line)) return headings[i];
    }
    return null;
  };
  const findPrevHorizontal = (line) => {
    // Same-row banner fragments only (e.g. Bollywood | Laila Majnu | runs…).
    // Never glue two independent side-by-side headlines (U.P. | Assam).
    for (let i = headings.length - 1; i >= 0; i -= 1) {
      const prev = headings[i];
      if (Math.abs(prev.y - line.y) > 4) continue;
      if (!similarSize(prev, line)) continue;
      const gap = line.x0 - prev.x1;
      if (gap > 36 || gap < -20) continue;
      const lineIndependent =
        /^[A-Z‘']/.test(line.text.trim()) && wordCount(line.text) >= 3;
      const prevIndependent =
        /^[A-Z‘']/.test(prev.text.trim()) && wordCount(prev.text) >= 4;
      // Two full headlines sitting side-by-side → separate articles.
      if (lineIndependent && prevIndependent && line.x0 > prev.x0 + 60) {
        continue;
      }
      // Allow continuation: short left fragment, or lowercase right fragment.
      if (wordCount(prev.text) <= 3 || /^[a-z]/.test(line.text.trim())) {
        return prev;
      }
    }
    return null;
  };
  const absorb = (prev, line) => {
    prev.text = `${prev.text} ${line.text}`.replace(/\s+/g, " ").trim();
    prev.x0 = Math.min(prev.x0, line.x0);
    prev.x1 = Math.max(prev.x1, line.x1);
    prev.yBottom = Math.min(prev.yBottom, line.y);
    prev.maxSize = Math.max(prev.maxSize, line.maxSize);
    prev.sourceLines.push(line);
    prev.wide = prev.x1 - prev.x0 > 420;
  };

  for (const line of headingLines) {
    const prevCol = findPrevSameColumn(line);
    const gap = prevCol ? prevCol.yBottom - line.y : Infinity;
    const stackMerge =
      prevCol &&
      gap >= -2 &&
      gap < Math.max(prevCol.maxSize, line.maxSize) * 1.7 &&
      similarSize(prevCol, line);

    if (stackMerge) {
      absorb(prevCol, line);
      continue;
    }

    const prevRow = findPrevHorizontal(line);
    if (prevRow) {
      absorb(prevRow, line);
      continue;
    }

    headings.push({
      text: line.text,
      x0: line.x0,
      x1: line.x1,
      y: line.y,
      yBottom: line.y,
      maxSize: line.maxSize,
      col: line.col,
      wide: line.x1 - line.x0 > 420,
      sourceLines: [line],
    });
  }

  // Second pass: merge leftover same-x0 vertical fragments.
  const merged = [];
  const used = new Set();
  const sorted = [...headings].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  for (let i = 0; i < sorted.length; i += 1) {
    if (used.has(i)) continue;
    const base = { ...sorted[i], sourceLines: [...sorted[i].sourceLines] };
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (used.has(j)) continue;
      const other = sorted[j];
      if (!sameX0(base, other)) continue;
      if (base.yBottom - other.y > Math.max(base.maxSize, other.maxSize) * 1.85) {
        continue;
      }
      if (!similarSize(base, other)) continue;
      base.text = `${base.text} ${other.text}`.replace(/\s+/g, " ").trim();
      base.x0 = Math.min(base.x0, other.x0);
      base.x1 = Math.max(base.x1, other.x1);
      base.yBottom = Math.min(base.yBottom, other.yBottom);
      base.maxSize = Math.max(base.maxSize, other.maxSize);
      base.sourceLines.push(...other.sourceLines);
      base.wide = base.x1 - base.x0 > 420;
      used.add(j);
    }
    merged.push(base);
  }

  return merged;
}

function findBestHeadingForBody(line, articles) {
  let best = null;
  let bestScore = Infinity;
  const sortedByX = [...articles].sort((a, b) => a.x0 - b.x0);

  for (const heading of articles) {
    if (line.y > heading.y + 4) continue; // body must be below heading

    const band = headingBodyBand(heading, sortedByX, line.y);
    const mid = (line.x0 + line.x1) / 2;
    const x0Delta = Math.abs(heading.x0 - line.x0);
    const tightX0 = x0Delta <= 55;
    const inBand =
      (line.x0 >= band.x0 - 8 && line.x0 <= band.x1 + 8) ||
      (mid >= band.x0 && mid <= band.x1);
    if (!inBand && !tightX0) continue;

    // Hard rule: a wide/upper story cannot own body once another headline
    // sits between them in an overlapping column band (STT under Stocks).
    if (hasInterveningHeading(heading, line, articles, sortedByX)) continue;

    const yDist = heading.y - line.y;
    const sameCol = heading.col === line.col;
    const score =
      yDist * 12 +
      x0Delta * 0.5 -
      (tightX0 ? 80 : 0) -
      (sameCol ? 25 : 0) -
      (inBand ? 40 : 0);

    if (score < bestScore) {
      bestScore = score;
      best = heading;
    }
  }

  return best;
}

function hasInterveningHeading(heading, line, articles, sortedByX) {
  const band = headingBodyBand(heading, sortedByX, line.y);
  for (const other of articles) {
    if (other === heading) continue;
    // other is between heading (above) and body line (below).
    if (other.y >= heading.y - 8) continue;
    if (other.y < line.y - 6) continue;
    const otherBand = headingBodyBand(other, sortedByX, line.y);
    if (!bandsOverlap(band, otherBand, 20)) continue;
    return true;
  }
  return false;
}

function bandsOverlap(a, b, pad = 0) {
  return a.x0 < b.x1 - pad && b.x0 < a.x1 - pad;
}

/**
 * Horizontal ownership for a heading: up to the next title to its right.
 * @param {number|null} atY PDF y of the body line being assigned. Wide
 *   banners must not be clipped by a lower-right story (e.g. Customs under
 *   Stocks' continuing right column on Investor pages).
 */
function headingBodyBand(heading, sortedByX, atY = null) {
  if (heading.wide) {
    // Side-by-side neighbor only: must sit near the banner vertically, and
    // already be above the body line (otherwise it is a lower story).
    const nextRight = sortedByX.find((h) => {
      if (h === heading || h.wide) return false;
      if (h.x0 <= heading.x0 + 80) return false;
      // Neighbor starts roughly beside the banner, not far below it.
      if (h.y < heading.y - 160) return false;
      // Do not let a title below this body line shrink the band.
      if (atY != null && h.y < atY - 12) return false;
      return true;
    });
    return {
      x0: heading.x0 - 24,
      x1: nextRight ? nextRight.x0 - 14 : heading.x1 + 48,
    };
  }
  // Prefer the nearest title to the right on the page, not only near in y —
  // stacked IN BRIEF items share x0 and must not inherit the center column.
  const nextRight = sortedByX.find((h) => {
    if (h === heading || h.x0 <= heading.x0 + 50) return false;
    // Same idea: a much-lower right title should not clip upper body.
    if (atY != null && h.y < atY - 12) return false;
    return true;
  });
  const right = nextRight
    ? nextRight.x0 - 14
    : heading.x0 + Math.max(heading.x1 - heading.x0, 220) + 30;
  return {
    x0: heading.x0 - 20,
    x1: Math.max(right, heading.x0 + 120),
  };
}

function findSameColumnHeadingAbove(line, articles, col) {
  let best = null;
  let bestGap = Infinity;
  for (const heading of articles) {
    if (heading.col !== col && !heading.wide) continue;
    if (line.y > heading.y + 4) continue;
    if (!heading.wide && !sameBand(heading, line)) continue;
    const gap = heading.y - line.y;
    if (gap < bestGap) {
      bestGap = gap;
      best = heading;
    }
  }
  return best;
}

function findWideHeadingAbove(line, articles) {
  let best = null;
  let bestGap = Infinity;
  for (const heading of articles) {
    if (!heading.wide) continue;
    if (line.y > heading.y + 4) continue;
    if (!sameBand(heading, line) && overlapRatio(heading, line) < 0.05) continue;
    const gap = heading.y - line.y;
    if (gap < bestGap) {
      bestGap = gap;
      best = heading;
    }
  }
  return best;
}

function sameBand(heading, line) {
  const mid = (line.x0 + line.x1) / 2;
  return mid >= heading.x0 - 20 && mid <= heading.x1 + 20;
}

function detectColumns(lines, pageWidth) {
  const centers = lines
    .filter((l) => l.maxSize >= 7.5 && l.maxSize <= 11)
    .map((l) => (l.x0 + l.x1) / 2)
    .sort((a, b) => a - b);

  if (centers.length < 30) {
    // Front-page teasers: use left edges of larger text too.
    const alt = lines
      .filter((l) => l.maxSize >= 12)
      .map((l) => l.x0)
      .sort((a, b) => a - b);
    return clusterCuts(alt, pageWidth, 55);
  }
  return clusterCuts(centers, pageWidth, 45);
}

function clusterCuts(xs, pageWidth, minGap) {
  if (!xs.length) return [{ x0: 0, x1: pageWidth + 1 }];
  const cuts = [];
  for (let i = 1; i < xs.length; i += 1) {
    const gap = xs[i] - xs[i - 1];
    if (gap >= minGap) cuts.push((xs[i - 1] + xs[i]) / 2);
  }
  const unique = [];
  for (const cut of cuts) {
    if (!unique.some((c) => Math.abs(c - cut) < 25)) unique.push(cut);
  }
  const bounds = [0, ...unique.sort((a, b) => a - b), pageWidth + 1];
  const cols = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    if (bounds[i + 1] - bounds[i] > 50) {
      cols.push({ x0: bounds[i], x1: bounds[i + 1] });
    }
  }
  return cols.length ? cols : [{ x0: 0, x1: pageWidth + 1 }];
}

function columnIndex(x, columns) {
  for (let i = 0; i < columns.length; i += 1) {
    if (x >= columns[i].x0 && x < columns[i].x1) return i;
  }
  return columns.length - 1;
}

function buildLineSegments(items, yTolerance, xGapSplit) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const buckets = [];

  for (const item of sorted) {
    const bucket = buckets.find((b) => Math.abs(b.y - item.y) <= yTolerance);
    if (!bucket) buckets.push({ y: item.y, items: [item] });
    else bucket.items.push(item);
  }

  const lines = [];
  for (const bucket of buckets) {
    const row = [...bucket.items].sort((a, b) => a.x - b.x);
    let segment = [];

    const flush = () => {
      if (!segment.length) return;
      const text = segment
        .map((i) => i.text)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      if (!text) {
        segment = [];
        return;
      }
      lines.push({
        text,
        y: bucket.y,
        x0: segment[0].x,
        x1: segment[segment.length - 1].x + segment[segment.length - 1].width,
        maxSize: Math.max(...segment.map((i) => i.size)),
      });
      segment = [];
    };

    for (const item of row) {
      if (!segment.length) {
        segment.push(item);
        continue;
      }
      const prev = segment[segment.length - 1];
      const gap = item.x - (prev.x + prev.width);
      // Split hard on column gutters; also split when a byline/title
      // fragment is horizontally distant from body run-on.
      const sizeJump = Math.abs(item.size - prev.size) > 4;
      if (gap > xGapSplit || (gap > 12 && sizeJump)) flush();
      segment.push(item);
    }
    flush();
  }

  return lines.sort((a, b) => b.y - a.y || a.x0 - b.x0);
}

function joinLines(lines) {
  if (!lines?.length) return "";

  const seen = new Set();
  const unique = [];
  for (const line of lines) {
    const key = `${line.y.toFixed(1)}|${line.x0.toFixed(1)}|${line.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }

  // Read newspaper body as columns: left→right columns, top→bottom inside each.
  const columns = clusterBodyColumns(unique);
  let out = "";
  for (const col of columns) {
    const part = joinColumnLines(col);
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    // Hyphenated word split across a column break ("ex-" / "pressed").
    if (/[a-z]{1,4}-$/i.test(out) && /^[a-z]/i.test(part)) {
      out = `${out.slice(0, -1)}${part}`;
    } else {
      out = `${out} ${part}`;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function clusterBodyColumns(lines) {
  // Greedy left-edge clustering: a new column starts only when x0 jumps
  // well past the current column's left edge (ignores mid-column indents).
  const sorted = [...lines].sort((a, b) => a.x0 - b.x0 || b.y - a.y);
  const cols = [];
  for (const line of sorted) {
    const last = cols[cols.length - 1];
    if (!last) {
      cols.push([line]);
      continue;
    }
    const edgeX = Math.min(...last.map((l) => l.x0));
    // ~100px gutters between newspaper body columns; mid-column
    // fragments (e.g. "he" at x=597) must not open a fake column that
    // then swallows the real next column (x=621).
    if (line.x0 - edgeX > 100) cols.push([line]);
    else last.push(line);
  }
  return cols;
}

function joinColumnLines(colLines) {
  const ordered = [...colLines].sort((a, b) => b.y - a.y || a.x0 - b.x0);
  let out = "";
  for (const line of ordered) {
    if (!out) {
      out = line.text;
      continue;
    }
    if (out.endsWith("-") && /^[a-z]/i.test(line.text)) {
      out = `${out.slice(0, -1)}${line.text}`;
    } else {
      out = `${out} ${line.text}`;
    }
  }
  return out.replace(/\s+/g, " ").trim();
}

function overlapRatio(a, b) {
  const overlap = horizontalOverlap(a, b);
  const denom = Math.max(1, Math.min(a.x1 - a.x0, b.x1 - b.x0));
  return overlap / denom;
}

function horizontalOverlap(a, b) {
  const left = Math.max(a.x0, b.x0);
  const right = Math.min(a.x1, b.x1);
  return Math.max(0, right - left);
}

function cleanupHeading(text) {
  return String(text || "")
    .replace(/\b\d{5,}\b/g, " ")
    // Strip prose glued after a finished quoted title:
    // ...world' disposal. It has adequate
    .replace(/(['’])\s+[a-z][a-z'-]*\.\s+[A-Z].*$/, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalize(text) {
  return text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

function isNoise(text) {
  return (
    /^the hindu$/i.test(text) ||
    /^saturday,/i.test(text) ||
    /^chennai$/i.test(text) ||
    /^www\.thehindu/i.test(text) ||
    /^https?:\/\//i.test(text) ||
    /^vol\./i.test(text) ||
    /^[incmyk]+$/i.test(text.replace(/\s/g, "")) ||
    /^\d{1,3}$/.test(text)
  );
}

function isStructuralNoise(text) {
  if (isNoise(text)) return true;
  if (/^follow us$/i.test(text)) return true;
  if (/^international edition$/i.test(text)) return true;
  if (/^\d+\s*pages$/i.test(text)) return true;
  if (/^VIEW\s*POINT$/i.test(text)) return true;
  if (/^Chairman,\s*Aditya Birla Group$/i.test(text)) return true;
  // Masthead date line.
  if (
    /^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),\s+[A-Z][a-z]+\s+\d{1,2},\s+\d{4}$/i.test(
      text
    )
  ) {
    return true;
  }
  // Long city strip under masthead.
  if ((text.match(/»/g) || []).length >= 3) return true;
  if (/Coimbatore.*Bengaluru.*Hyderabad/i.test(text)) return true;
  return false;
}

function isKicker(text) {
  const cleaned = text.replace(/[^A-Za-z\s'’]/g, "").trim();
  if (!cleaned || cleaned.length > 28) return false;
  const letters = cleaned.replace(/\s+/g, "");
  if (letters.length < 3) return false;
  const upper = letters.replace(/[^A-Z]/g, "").length;
  return upper / letters.length >= 0.85;
}

function isJunkHeading(line) {
  const words = line.text.split(/\s+/).filter(Boolean);
  // Drop-cap / fractured glyph lines only — do NOT reject short real titles
  // like "making India" (2 words, large font).
  if (words[0]?.length === 1 && line.maxSize >= 28) return true;
  if (/^t\s+[a-z]/i.test(line.text) && line.maxSize >= 28) return true;
  if (words.length === 1 && words[0].length <= 2 && line.maxSize >= 28) return true;
  return false;
}

/** Body/sentence fragments that should never become headline text. */
function looksLikeProse(text, size = 99) {
  const t = String(text || "").trim();
  if (!t) return true;
  // Only reject lowercase starts at body point sizes. Teaser/title
  // continuations ("lion sanctuaries…", "making India") are larger.
  if (/^[a-z]/.test(t) && size < 12.5) return true;
  if (/^[‘'"][a-z]/.test(t) && size < 12.5) return true;
  // e.g. "disposal. It has adequate" (body pulled into a teaser line)
  if (/^[A-Za-z]{2,}\.\s+[A-Z]/.test(t) && wordCount(t) <= 8) return true;
  return false;
}
