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

const COLORS: Record<MetricKey, string> = {
  mood: '#2e7d32',
  productivity: '#1565c0',
  routine: '#6a1b9a',
  anxiety: '#ef6c00',
  stress: '#c62828',
};

// Two stacked panels: "positive" metrics read higher = better, "negative" read higher = worse.
// Splitting them keeps each panel's direction consistent, so a rising line means the same thing.
const POSITIVE_KEYS: readonly MetricKey[] = ['mood', 'productivity', 'routine'];
const NEGATIVE_KEYS: readonly MetricKey[] = ['anxiety', 'stress'];
const ALL_KEYS: readonly MetricKey[] = [...POSITIVE_KEYS, ...NEGATIVE_KEYS];

interface DayPoint {
  date: string;
  values: Record<MetricKey, number | null>;
}

/** Average all entries for a given day per metric. Days with no data stay null and get no marker. */
function averageByDate(rows: MetricsRow[], dates: string[]): DayPoint[] {
  const acc = new Map<string, Record<MetricKey, number[]>>();
  for (const date of dates) {
    acc.set(date, { mood: [], anxiety: [], stress: [], productivity: [], routine: [] });
  }
  for (const row of rows) {
    const bucket = acc.get(row.date);
    if (!bucket) continue;
    for (const key of ALL_KEYS) {
      const value = row[key];
      if (value !== null && value !== undefined) bucket[key].push(value);
    }
  }
  return dates.map((date) => {
    const bucket = acc.get(date)!;
    const values = {} as Record<MetricKey, number | null>;
    for (const key of ALL_KEYS) {
      const arr = bucket[key];
      values[key] = arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;
    }
    return { date, values };
  });
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Weekend = Saturday/Sunday, computed from the calendar date (timezone-independent). */
function isWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow === 0 || dow === 6;
}

interface PanelOptions {
  title: string;
  keys: readonly MetricKey[];
  top: number;
  bottom: number;
  titleY: number;
  legendY: number;
  showXLabels: boolean;
  weekendLabel?: string;
}

function buildSvg(points: DayPoint[], title: string): string {
  const W = 940;
  const padL = 54;
  const padR = 24;
  const plotW = W - padL - padR;
  const n = points.length;
  const spacing = n > 1 ? plotW / (n - 1) : plotW;
  const strings = t();

  const xAt = (i: number): number => (n <= 1 ? padL + plotW / 2 : padL + (i / (n - 1)) * plotW);

  // Layout: main title, then two stacked panels sharing the x-axis (labels under the lower panel).
  const A_TITLE_Y = 54;
  const A_LEGEND_Y = 76;
  const A_TOP = 90;
  const A_BOTTOM = 272;
  const B_TITLE_Y = 302;
  const B_LEGEND_Y = 324;
  const B_TOP = 338;
  const B_BOTTOM = 520;
  const X_LABEL_Y = B_BOTTOM + 20;
  const H = X_LABEL_Y + 14;

  // Weekend (Sat/Sun) day indices, shaded as background bands in both panels.
  const weekendIdx: number[] = [];
  for (let i = 0; i < n; i++) if (isWeekend(points[i].date)) weekendIdx.push(i);

  const step = Math.max(1, Math.round(n / 6));

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT_FAMILY}">`,
  );
  parts.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  parts.push(`<text x="${padL}" y="30" font-size="20" font-weight="bold" fill="#111827">${esc(title)}</text>`);

  const drawPanel = (opts: PanelOptions): void => {
    const { keys, top, bottom } = opts;
    const panelH = bottom - top;
    const yAt = (v: number): number => top + (1 - v / 10) * panelH;

    // Weekend background bands (drawn first, behind gridlines and series).
    for (const i of weekendIdx) {
      const left = Math.max(padL, xAt(i) - spacing / 2);
      const right = Math.min(padL + plotW, xAt(i) + spacing / 2);
      parts.push(`<rect x="${left.toFixed(1)}" y="${top}" width="${(right - left).toFixed(1)}" height="${panelH}" fill="#eceff3"/>`);
    }

    // Panel title
    parts.push(`<text x="${padL}" y="${opts.titleY}" font-size="13" font-weight="bold" fill="#4b5563">${esc(opts.title)}</text>`);

    // Horizontal gridlines + Y axis labels (0..10)
    for (let v = 0; v <= 10; v += 2) {
      const y = yAt(v);
      parts.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + plotW}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`);
      parts.push(`<text x="${padL - 10}" y="${(y + 4).toFixed(1)}" font-size="12" fill="#9ca3af" text-anchor="end">${v}</text>`);
    }

    // Vertical gridlines (about every sixth day); x labels only under the lower panel
    for (let i = 0; i < n; i++) {
      if (i % step !== 0 && i !== n - 1) continue;
      const x = xAt(i);
      parts.push(`<line x1="${x.toFixed(1)}" y1="${top}" x2="${x.toFixed(1)}" y2="${bottom}" stroke="#f3f4f6" stroke-width="1"/>`);
      if (opts.showXLabels) {
        parts.push(`<text x="${x.toFixed(1)}" y="${X_LABEL_Y}" font-size="11" fill="#9ca3af" text-anchor="middle">${esc(points[i].date.slice(5))}</text>`);
      }
    }

    // Legend (metric swatches, plus an optional weekend swatch)
    let legendX = padL;
    for (const key of keys) {
      const label = strings.metricNames[key];
      parts.push(`<rect x="${legendX.toFixed(1)}" y="${opts.legendY - 11}" width="14" height="14" rx="3" fill="${COLORS[key]}"/>`);
      parts.push(`<text x="${(legendX + 20).toFixed(1)}" y="${opts.legendY}" font-size="14" fill="#374151">${esc(label)}</text>`);
      legendX += 20 + label.length * 8.6 + 24;
    }
    if (opts.weekendLabel) {
      parts.push(`<rect x="${legendX.toFixed(1)}" y="${opts.legendY - 11}" width="14" height="14" rx="3" fill="#eceff3" stroke="#d1d5db" stroke-width="1"/>`);
      parts.push(`<text x="${(legendX + 20).toFixed(1)}" y="${opts.legendY}" font-size="14" fill="#374151">${esc(opts.weekendLabel)}</text>`);
    }

    // Series: connect every recorded value across the calendar timeline. Missing days have no
    // marker, so they remain visible without interrupting the trend line.
    for (const key of keys) {
      const color = COLORS[key];
      const linePoints: string[] = [];
      const markers: string[] = [];
      for (let i = 0; i < n; i++) {
        const value = points[i].values[key];
        if (value === null) continue;
        const x = xAt(i);
        const y = yAt(value);
        linePoints.push(`${x.toFixed(1)},${y.toFixed(1)}`);
        markers.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${color}"/>`);
      }
      if (linePoints.length >= 2) {
        parts.push(
          `<polyline fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" points="${linePoints.join(' ')}"/>`,
        );
      }
      parts.push(...markers);
    }

    // Frame (left + bottom)
    parts.push(`<line x1="${padL}" y1="${top}" x2="${padL}" y2="${bottom}" stroke="#d1d5db" stroke-width="1"/>`);
    parts.push(`<line x1="${padL}" y1="${bottom}" x2="${padL + plotW}" y2="${bottom}" stroke="#d1d5db" stroke-width="1"/>`);
  };

  drawPanel({
    title: strings.chartPanelPositive,
    keys: POSITIVE_KEYS,
    top: A_TOP,
    bottom: A_BOTTOM,
    titleY: A_TITLE_Y,
    legendY: A_LEGEND_Y,
    showXLabels: false,
    weekendLabel: strings.chartWeekend,
  });
  drawPanel({
    title: strings.chartPanelNegative,
    keys: NEGATIVE_KEYS,
    top: B_TOP,
    bottom: B_BOTTOM,
    titleY: B_TITLE_Y,
    legendY: B_LEGEND_Y,
    showXLabels: true,
  });

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

  const hasAny = rows.some((row) => ALL_KEYS.some((key) => row[key] !== null && row[key] !== undefined));
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
