import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';
import { InputFile, type Api } from 'grammy';
import { queries } from '../db/index.js';
import type { MetricsRow } from '../db/queries.js';
import { t } from '../i18n/index.js';
import { shiftLocalDate } from '../utils/date.js';
import type { CommentTarget } from '../utils/telegram.js';
import { logError, logInfo, logWarn } from '../utils/logger.js';

// Bundled font so text renders on headless servers with no system fonts installed.
// DejaVu Sans covers Latin + Cyrillic, which we need for localized legend labels.
// Resolved relative to the compiled module (dist/services/) → repo-root/assets/fonts.
const FONT_PATH = fileURLToPath(new URL('../../assets/fonts/DejaVuSans.ttf', import.meta.url));
const FONT_FAMILY = 'DejaVu Sans';

// resvg does NOT throw on a missing font file — it silently renders text-less output.
// Detect that once so a missing/undeployed font degrades to "no chart" (loudly logged)
// instead of posting a blank, label-less chart while logging success.
const FONT_AVAILABLE = existsSync(FONT_PATH);
if (!FONT_AVAILABLE) {
  logWarn('chart.font.missing', { fontPath: FONT_PATH });
}

const DEFAULT_CHART_DAYS = 30;

type MetricKey = 'mood' | 'anxiety' | 'stress' | 'productivity' | 'routine';

const SERIES: ReadonlyArray<{ key: MetricKey; color: string }> = [
  { key: 'mood', color: '#2e7d32' },
  { key: 'anxiety', color: '#ef6c00' },
  { key: 'stress', color: '#c62828' },
  { key: 'productivity', color: '#1565c0' },
  { key: 'routine', color: '#6a1b9a' },
];

interface DayPoint {
  date: string;
  values: Record<MetricKey, number | null>;
}

/** Average all entries for a given day per metric. Days with no data stay null (rendered as a gap). */
function averageByDate(rows: MetricsRow[], dates: string[]): DayPoint[] {
  const acc = new Map<string, Record<MetricKey, number[]>>();
  for (const date of dates) {
    acc.set(date, { mood: [], anxiety: [], stress: [], productivity: [], routine: [] });
  }
  for (const row of rows) {
    const bucket = acc.get(row.date);
    if (!bucket) continue;
    for (const { key } of SERIES) {
      const value = row[key];
      if (value !== null && value !== undefined) bucket[key].push(value);
    }
  }
  return dates.map((date) => {
    const bucket = acc.get(date)!;
    const values = {} as Record<MetricKey, number | null>;
    for (const { key } of SERIES) {
      const arr = bucket[key];
      values[key] = arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;
    }
    return { date, values };
  });
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSvg(points: DayPoint[], title: string): string {
  const W = 940;
  const H = 560;
  const padL = 54;
  const padR = 24;
  const padT = 78;
  const padB = 58;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const n = points.length;

  const xAt = (i: number): number => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);
  const yAt = (v: number): number => padT + (1 - v / 10) * plotH;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}">`,
  );
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);

  // Title
  parts.push(`<text x="${padL}" y="32" font-size="20" font-weight="bold" fill="#111827">${esc(title)}</text>`);

  // Legend
  let legendX = padL;
  const legendY = 56;
  for (const { key, color } of SERIES) {
    const label = t().metricNames[key];
    parts.push(`<rect x="${legendX}" y="${legendY - 11}" width="14" height="14" rx="3" fill="${color}"/>`);
    parts.push(`<text x="${legendX + 20}" y="${legendY}" font-size="14" fill="#374151">${esc(label)}</text>`);
    legendX += 20 + label.length * 8.6 + 24;
  }

  // Horizontal gridlines + Y axis labels (0..10)
  for (let v = 0; v <= 10; v += 2) {
    const y = yAt(v);
    parts.push(`<line x1="${padL}" y1="${y}" x2="${padL + plotW}" y2="${y}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="${padL - 10}" y="${y + 4}" font-size="12" fill="#9ca3af" text-anchor="end">${v}</text>`);
  }

  // X axis labels (about every sixth day, always include the last)
  const step = Math.max(1, Math.round(n / 6));
  for (let i = 0; i < n; i++) {
    if (i % step !== 0 && i !== n - 1) continue;
    const x = xAt(i);
    parts.push(`<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="#f3f4f6" stroke-width="1"/>`);
    parts.push(
      `<text x="${x}" y="${padT + plotH + 20}" font-size="11" fill="#9ca3af" text-anchor="middle">${esc(points[i].date.slice(5))}</text>`,
    );
  }

  // Series: draw each contiguous run as a polyline (gaps break the line), plus a dot per real point.
  for (const { key, color } of SERIES) {
    let segment: string[] = [];
    const flush = (): void => {
      if (segment.length >= 2) {
        parts.push(
          `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${segment.join(' ')}"/>`,
        );
      }
      segment = [];
    };
    for (let i = 0; i < n; i++) {
      const value = points[i].values[key];
      if (value === null) {
        flush();
        continue;
      }
      const x = xAt(i);
      const y = yAt(value);
      segment.push(`${x.toFixed(1)},${y.toFixed(1)}`);
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`);
    }
    flush();
  }

  // Axis frame
  parts.push(`<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="1"/>`);
  parts.push(
    `<line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#d1d5db" stroke-width="1"/>`,
  );

  parts.push('</svg>');
  return parts.join('');
}

/**
 * Render a PNG line chart of the daily metrics for the `days`-day window ending at `endDate`.
 * Returns null when there is no metric data at all in the window (nothing worth plotting).
 */
export function renderMetricsChart(endDate: string, days: number = DEFAULT_CHART_DAYS): Buffer | null {
  // Without the font, resvg would produce a chart with no readable labels — skip instead.
  if (!FONT_AVAILABLE) {
    logError('chart.render.no_font', new Error('bundled font missing'), { fontPath: FONT_PATH, endDate, days });
    return null;
  }

  const startDate = shiftLocalDate(endDate, -(days - 1));
  const rows = queries.getMetricsByDateRange(startDate, endDate);

  const hasAny = rows.some((row) => SERIES.some(({ key }) => row[key] !== null && row[key] !== undefined));
  if (!hasAny) return null;

  const dates: string[] = [];
  for (let i = 0; i < days; i++) dates.push(shiftLocalDate(startDate, i));
  const points = averageByDate(rows, dates);

  const title = t().chartTitle.replace('{days}', String(days));
  const svg = buildSvg(points, title);

  const start = Date.now();
  const resvg = new Resvg(svg, {
    font: { fontFiles: [FONT_PATH], loadSystemFonts: false, defaultFontFamily: FONT_FAMILY },
    background: '#ffffff',
  });
  const png = resvg.render().asPng();
  logInfo('chart.render.complete', {
    endDate,
    startDate,
    days,
    metricRows: rows.length,
    svgChars: svg.length,
    pngBytes: png.length,
    elapsedMs: Date.now() - start,
  });
  return png;
}

/**
 * Render the metrics chart and post it as a photo under the given comment target.
 * Never throws — a chart failure must not abort the report it accompanies.
 */
export async function sendMetricsChart(
  api: Api,
  target: CommentTarget,
  endDate: string,
  days: number = DEFAULT_CHART_DAYS,
): Promise<void> {
  try {
    const png = renderMetricsChart(endDate, days);
    if (!png) {
      logInfo('chart.send.skip_no_data', { endDate, days });
      return;
    }
    const startDate = shiftLocalDate(endDate, -(days - 1));
    const caption = t()
      .chartCaption.replace('{days}', String(days))
      .replace('{start}', startDate)
      .replace('{end}', endDate);
    await api.sendPhoto(target.chatId, new InputFile(png, `metrics-${endDate}.png`), {
      reply_to_message_id: target.replyToMessageId,
      caption,
    });
    logInfo('chart.send.complete', { chatId: target.chatId, endDate, days, pngBytes: png.length });
  } catch (err) {
    logError('chart.send.failed', err, { endDate, days });
  }
}
