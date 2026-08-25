#!/usr/bin/env node
// Render the final HTML report: reads stats.json (quantitative side, produced
// by compute-stats.mjs) and prose.html (narrative side, written by the main
// model for this specific report - see SKILL.md step 7-8), and stitches them
// together into a single self-contained HTML page with inline SVG charts.
//
// prose.html must contain these placeholders (plain text tokens, replaced
// verbatim - see SKILL.md for the full list and where each one is meant to
// sit relative to the narrative sections):
//   {{KPI_ROW}}               top-of-page KPI tiles
//   {{CHART_MOOD}}            mood line chart with raw dots + 7-day rolling mean
//   {{CHART_SMALL_MULTIPLES}} small-multiple charts for the other daily metrics
//   {{CHART_SENTIMENT}}       diverging pos/neu/neg bar per month
//   {{CHART_DISTORTIONS}}     top cognitive distortions, horizontal bars
//   {{CHART_HOURS}}           entries by hour of day
//   {{CHART_WINS}}            "wins" logged per week
//   {{CHART_MONTHLY_MOOD}}    mean mood per month, bars (lowest month highlighted)
//   {{CHART_ORBITS}}          recurring themes, ranked by how many distinct days each spans
//   {{CHART_DISTORTION_TREND}} small multiples: top distortions per month, per 10 entries
//
// The last three read stats.json fields that compute-stats.mjs only emits when the
// source database has them (orbits/orbitsByMonth, distortionsByMonth, monthlyVolume).
// Each renders as an empty string when its data is missing, so a prose file may include
// them unconditionally.
//
// Usage:
//   node gen.mjs --stats export/stats.json --prose prose.html --out report.html [--title "..."]
//
// IMPORTANT - personalization per report:
// The EVENTS and BANDS arrays below are intentionally empty. They exist to
// mark period-specific life events / date ranges on the mood chart (e.g. a
// trip, a milestone). Before generating a report, fill them in directly in
// a working copy of this file using neutral placeholders if you don't want
// to hardcode real content in a shared script, e.g.:
//   EVENTS = [['2026-04-16', '{событие 1}', 0], ['2026-05-12', '{событие 2}', 1]];
//   BANDS  = [['2026-04-17', '2026-05-03', '{период 1}']];
// Never commit real event labels into this shared template.

import fs from 'node:fs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[key] = val;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const statsPath = args.stats;
const prosePath = args.prose;
const outPath = args.out || 'report.html';
const pageTitle = args.title || 'Отчёт по дневнику';

if (!statsPath || !prosePath) {
  console.error('Usage: node gen.mjs --stats <stats.json> --prose <prose.html> [--out <report.html>] [--title "..."]');
  process.exit(1);
}

const S = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
const prose = fs.readFileSync(prosePath, 'utf8');

// ---------- per-report personalization (fill before running, see header) ----------
const BANDS = []; // fill with period-specific date ranges, e.g. [['2026-04-17','2026-05-03','{период 1}']]
const EVENTS = []; // fill with period-specific events, e.g. [['2026-05-12','{событие 1}',1]] - third value (0/1) alternates label row to avoid overlap

// ---------- date range + month ticks (derived from data, not hardcoded) ----------
const [rangeStartStr, rangeEndStr] = S.dateRange || [];
const D0 = new Date(`${rangeStartStr}T00:00:00Z`).getTime();
const D1 = new Date(`${rangeEndStr}T00:00:00Z`).getTime();
const dayMs = 86400000;

const RU_MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const RU_MONTHS_FULL = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const toISO = (d) => d.toISOString().slice(0, 10);
const lastDayOfMonth = (year, monthIdx) => new Date(Date.UTC(year, monthIdx + 1, 0)).getUTCDate();

function monthTicks(d0, d1) {
  const ticks = [[toISO(d0), RU_MONTHS_SHORT[d0.getUTCMonth()]]];
  const cursor = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1));
  while (cursor.getTime() <= d1.getTime()) {
    ticks.push([toISO(cursor), RU_MONTHS_SHORT[cursor.getUTCMonth()]]);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}
const MONTH_TICKS = monthTicks(new Date(D0), new Date(D1));

// ---------- helpers ----------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f1 = (v) => (v == null ? '—' : (Math.round(v * 10) / 10).toString().replace('.', ','));
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

function xScale(dateStr, x0, x1) {
  const t = new Date(`${dateStr}T00:00:00Z`).getTime();
  return x0 + ((t - D0) / (D1 - D0)) * (x1 - x0);
}
// Trailing 7-calendar-day mean, computed on the fly from the raw daily series.
function rolling(series, key) {
  return series.map((p) => {
    const t = new Date(`${p.date}T00:00:00Z`).getTime();
    const win = series
      .filter((q) => {
        const u = new Date(`${q.date}T00:00:00Z`).getTime();
        return u > t - 7 * dayMs && u <= t && q[key] != null;
      })
      .map((q) => q[key]);
    return win.length ? win.reduce((a, b) => a + b, 0) / win.length : null;
  });
}
function roundedRightRect(x, y, w, h, r) {
  if (w < r) r = Math.max(0, w);
  return `M${x},${y} h${w - r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} a${r},${r} 0 0 1 ${-r},${r} h${-(w - r)} z`;
}
function roundedTopRect(x, y, w, h, r) {
  if (h < r) r = Math.max(0, h);
  return `M${x},${y + h} v${-(h - r)} a${r},${r} 0 0 1 ${r},${-r} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - r} z`;
}
function leftRounded(x, y, w, h, r) {
  if (w < r) r = Math.max(0, w);
  return `M${x + w},${y} v${h} h${-(w - r)} a${r},${r} 0 0 1 ${-r},${-r} v${-(h - 2 * r)} a${r},${r} 0 0 1 ${r},${-r} z`;
}

// ---------- KPI row (all values computed from stats.json, nothing hardcoded) ----------
const wordsLabel = (n) => (n == null ? '—' : n >= 1000 ? `${Math.round(n / 1000)} тыс. слов` : `${n} слов`);

function kpiRow() {
  const kpi = S.kpi || {};
  const items = [
    ['Записей', String(S.entryCount ?? '—'), 'голос и текст'],
    [
      'Дней с записями',
      `${kpi.daysCovered ?? '—'} из ${kpi.totalDaysInRange ?? '—'}`,
      kpi.totalDaysInRange ? `${Math.round((kpi.daysCovered / kpi.totalDaysInRange) * 100)}% покрытия` : '',
    ],
    ['Лучший стрик', `${kpi.bestStreak ?? '—'} дней подряд`, ''],
    [
      'Наговорено и написано',
      wordsLabel(kpi.totalWords),
      kpi.voiceMinutes ? `${Math.round(kpi.voiceMinutes)} мин голоса` : '',
    ],
    ['Благодарностей', String(S.gratTotal ?? '—'), 'зафиксировано ботом'],
    ['Побед', String(S.winsTotalItems ?? '—'), 'зафиксировано ботом'],
  ];
  return (
    `<div class="kpi-row">` +
    items.map(([l, v, s]) => `<div class="kpi"><div class="kpi-label">${l}</div><div class="kpi-value">${v}</div><div class="kpi-sub">${s}</div></div>`).join('') +
    `</div>`
  );
}

// ---------- Chart: mood ----------
function moodChart() {
  const W = 960, H = 330, L = 34, R = 14, T = 46, B = 30;
  const x0 = L, x1 = W - R, y0 = H - B, y1 = T;
  const y = (v) => y0 - (v / 10) * (y0 - y1);
  const pts = S.series.filter((p) => p.mood != null);
  const roll = rolling(S.series, 'mood');
  let g = '';
  for (const [a, b, lab] of BANDS) {
    const xa = xScale(a, x0, x1), xb = xScale(b, x0, x1);
    g += `<rect x="${xa.toFixed(1)}" y="${y1}" width="${(xb - xa).toFixed(1)}" height="${y0 - y1}" fill="var(--band)"/>`;
    g += `<text x="${((xa + xb) / 2).toFixed(1)}" y="${y0 - 6}" text-anchor="middle" class="band-label">${esc(lab)}</text>`;
  }
  for (const v of [0, 2, 4, 6, 8, 10]) {
    g += `<line x1="${x0}" y1="${y(v)}" x2="${x1}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${x0 - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${v}</text>`;
  }
  for (const [d, lab] of MONTH_TICKS) {
    const xx = xScale(d, x0, x1);
    g += `<text x="${xx.toFixed(1)}" y="${y0 + 20}" class="tick" text-anchor="${d === MONTH_TICKS[0][0] ? 'start' : 'middle'}">${lab}</text>`;
  }
  const rp = [];
  S.series.forEach((p, i) => { if (roll[i] != null) rp.push([xScale(p.date, x0, x1), y(roll[i])]); });
  if (rp.length) {
    const line = rp.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    g += `<path d="${line} L${rp[rp.length - 1][0].toFixed(1)},${y0} L${rp[0][0].toFixed(1)},${y0} Z" fill="var(--accent)" opacity="0.08"/>`;
    for (const p of pts) {
      g += `<circle cx="${xScale(p.date, x0, x1).toFixed(1)}" cy="${y(p.mood).toFixed(1)}" r="3" fill="var(--accent)" opacity="0.35"/>`;
    }
    g += `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  for (const [d, lab, row] of EVENTS) {
    const xx = xScale(d, x0, x1);
    const ty = row === 0 ? 16 : 30;
    g += `<line x1="${xx.toFixed(1)}" y1="${ty + 4}" x2="${xx.toFixed(1)}" y2="${y0}" stroke="var(--baseline)" stroke-width="1"/>`;
    let anchor = 'middle', tx = xx;
    if (xx > x1 - 90) { anchor = 'end'; tx = xx + 4; }
    g += `<text x="${tx.toFixed(1)}" y="${ty}" text-anchor="${anchor}" class="event-label">${esc(lab)}</text>`;
  }
  g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="var(--baseline)" stroke-width="1"/>`;
  const hover = S.series
    .map((p, i) => ({ d: p.date, m: p.mood, r: roll[i] != null ? +roll[i].toFixed(1) : null, x: +xScale(p.date, x0, x1).toFixed(1) }))
    .filter((p) => p.m != null);
  const table = `<details class="tw"><summary>Данные: настроение по дням</summary><div class="tscroll"><table><thead><tr><th>Дата</th><th>Настроение</th><th>Среднее 7 дн.</th></tr></thead><tbody>` +
    hover.map((p) => `<tr><td>${p.d}</td><td>${f1(p.m)}</td><td>${f1(p.r)}</td></tr>`).join('') + `</tbody></table></div></details>`;
  return `<figure class="chart" id="mood-chart"><figcaption class="chart-title">Настроение, 0–10 · точки — дни, линия — среднее за 7 дней</figcaption>
<div class="chart-scroll"><div class="chart-box" style="min-width:720px">
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Настроение по дням за период отчёта">${g}
<rect id="mood-overlay" x="${x0}" y="${y1}" width="${x1 - x0}" height="${y0 - y1}" fill="transparent"/>
<line id="mood-cross" x1="0" y1="${y1}" x2="0" y2="${y0}" stroke="var(--muted)" stroke-width="1" opacity="0"/>
</svg></div></div><div class="tip" id="mood-tip" hidden></div>${table}
<script type="application/json" id="mood-data">${JSON.stringify({ pts: hover, y1, y0 })}</script></figure>`;
}

// ---------- small multiples for the other daily metrics ----------
const MINI_LABELS = { anxiety: 'Тревога', stress: 'Стресс', productivity: 'Продуктивность', routine: 'Режим дня' };

function miniChart(key, title, note) {
  const W = 310, H = 150, L = 26, R = 8, T = 16, B = 24;
  const x0 = L, x1 = W - R, y0 = H - B, y1 = T;
  const y = (v) => y0 - (v / 10) * (y0 - y1);
  const roll = rolling(S.series, key);
  let g = '';
  for (const v of [0, 5, 10]) {
    g += `<line x1="${x0}" y1="${y(v)}" x2="${x1}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${x0 - 6}" y="${y(v) + 3.5}" text-anchor="end" class="tick s">${v}</text>`;
  }
  for (const [d, lab] of MONTH_TICKS) {
    const xx = xScale(d, x0, x1);
    g += `<text x="${xx.toFixed(1)}" y="${y0 + 16}" class="tick s" text-anchor="${d === MONTH_TICKS[0][0] ? 'start' : 'middle'}">${lab}</text>`;
  }
  for (const p of S.series) {
    if (p[key] != null) g += `<circle cx="${xScale(p.date, x0, x1).toFixed(1)}" cy="${y(p[key]).toFixed(1)}" r="2" fill="var(--accent)" opacity="0.3"/>`;
  }
  const rp = [];
  S.series.forEach((p, i) => { if (roll[i] != null && p[key] != null) rp.push([xScale(p.date, x0, x1), y(roll[i])]); });
  if (rp.length) {
    const line = rp.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join('');
    g += `<path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
  }
  g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="var(--baseline)" stroke-width="1"/>`;
  return `<figure class="chart mini"><figcaption class="chart-title">${esc(title)}<span class="chart-note">${esc(note)}</span></figcaption>
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${g}</svg></figure>`;
}

function smallMultiples() {
  const avg = (k) => { const v = S.series.filter((p) => p[k] != null).map((p) => p[k]); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const keys = Object.keys(MINI_LABELS).filter((k) => (S.coverage?.[k] ?? 0) > 0);
  const charts = keys.map((k) => miniChart(k, MINI_LABELS[k], `в среднем ${f1(avg(k))}`)).join('\n');
  const t = `<details class="tw"><summary>Данные: средние по месяцам</summary><div class="tscroll"><table><thead><tr><th>Месяц</th>` +
    keys.map((k) => `<th>${MINI_LABELS[k]}</th>`).join('') + `<th>Дней</th></tr></thead><tbody>` +
    S.monthly.map((m) => `<tr><td>${m.month}</td>` + keys.map((k) => `<td>${f1(m[k])}</td>`).join('') + `<td>${m.days}</td></tr>`).join('') +
    `</tbody></table></div></details>`;
  return `<div class="mini-row">${charts}</div>${t}`;
}

// ---------- sentiment diverging chart ----------
function sentimentChart() {
  const monthKeys = Object.keys(S.sentMonthly || {}).sort();
  const lastKey = monthKeys[monthKeys.length - 1];
  const firstKey = monthKeys[0];
  const isPartial = (key) => {
    const [y, m] = key.split('-').map(Number);
    if (key === firstKey && rangeStartStr && !rangeStartStr.endsWith('-01')) return true;
    if (key === lastKey && rangeEndStr) {
      const last = lastDayOfMonth(y, m - 1);
      const endDay = Number(rangeEndStr.split('-')[2]);
      return endDay < last;
    }
    return false;
  };
  const months = monthKeys.map((key) => {
    const [y, m] = key.split('-').map(Number);
    return [key, RU_MONTHS_FULL[m - 1] + (isPartial(key) ? '*' : '')];
  });
  const W = 760, rowH = 36, barH = 20, L = 84, R = 60, T = 24;
  const H = T + months.length * rowH + 26;
  const cx = L + (W - L - R) / 2;
  const half = (W - L - R) / 2;
  let g = '';
  g += `<line x1="${cx}" y1="${T - 10}" x2="${cx}" y2="${T + months.length * rowH}" stroke="var(--baseline)" stroke-width="1"/>`;
  months.forEach(([key, lab], i) => {
    const m = S.sentMonthly[key];
    if (!m || !m.total) return;
    const yy = T + i * rowH + (rowH - barH) / 2;
    const pn = m.negative / m.total, pz = m.neutral / m.total, pp = m.positive / m.total;
    const wn = pn * half, wz = pz * half, wp = pp * half;
    const zl = cx - wz / 2, zr = cx + wz / 2;
    g += `<text x="${L - 10}" y="${yy + barH / 2 + 4}" text-anchor="end" class="axis-label">${esc(lab)}</text>`;
    g += `<rect x="${zl.toFixed(1)}" y="${yy}" width="${wz.toFixed(1)}" height="${barH}" fill="var(--neutral-seg)"><title>${esc(lab)}: нейтральных ${m.neutral} (${Math.round(pz * 100)}%)</title></rect>`;
    g += `<path d="${leftRounded(zl - 2 - wn, yy, wn, barH, 4)}" fill="var(--neg)"><title>${esc(lab)}: негативных ${m.negative} (${Math.round(pn * 100)}%)</title></path>`;
    g += `<path d="${roundedRightRect(zr + 2, yy, wp, barH, 4)}" fill="var(--accent)"><title>${esc(lab)}: позитивных ${m.positive} (${Math.round(pp * 100)}%)</title></path>`;
    g += `<text x="${(zl - wn - 8).toFixed(1)}" y="${yy + barH / 2 + 4}" text-anchor="end" class="val neg-val">${Math.round(pn * 100)}%</text>`;
    g += `<text x="${(zr + wp + 8).toFixed(1)}" y="${yy + barH / 2 + 4}" class="val pos-val">${Math.round(pp * 100)}%</text>`;
  });
  const leg = `<div class="legend"><span><i style="background:var(--neg)"></i>негативные</span><span><i style="background:var(--neutral-seg)"></i>нейтральные</span><span><i style="background:var(--accent)"></i>позитивные</span></div>`;
  const t = `<details class="tw"><summary>Данные: тон записей</summary><div class="tscroll"><table><thead><tr><th>Месяц</th><th>Позитив</th><th>Нейтрально</th><th>Негатив</th><th>Всего</th></tr></thead><tbody>` +
    months.map(([k, l]) => { const m = S.sentMonthly[k]; return m ? `<tr><td>${l}</td><td>${m.positive}</td><td>${m.neutral}</td><td>${m.negative}</td><td>${m.total}</td></tr>` : ''; }).join('') +
    `</tbody></table></div></details>`;
  const partialNote = months.some(([, l]) => l.endsWith('*')) ? `<p class="footnote">* месяц отражён не полностью</p>` : '';
  return `<figure class="chart"><figcaption class="chart-title">Тон записей по оценке модели · доля от записей месяца</figcaption>
<div class="chart-scroll"><div class="chart-box" style="min-width:640px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Тон записей по месяцам">${g}</svg></div></div>${leg}
${partialNote}${t}</figure>`;
}

// ---------- distortions ----------
function distortionsChart() {
  const data = (S.topDistortions || []).slice(0, 10);
  if (!data.length) return '';
  const max = data[0][1];
  const W = 760, rowH = 30, barH = 18, L = 220, R = 44, T = 8;
  const H = T + data.length * rowH + 8;
  let g = '';
  data.forEach(([name, n], i) => {
    const yy = T + i * rowH + (rowH - barH) / 2;
    const w = (n / max) * (W - L - R);
    g += `<text x="${L - 10}" y="${yy + barH / 2 + 4}" text-anchor="end" class="axis-label">${esc(cap(name))}</text>`;
    g += `<path d="${roundedRightRect(L, yy, w, barH, 4)}" fill="var(--accent)"><title>${esc(cap(name))}: ${n}</title></path>`;
    g += `<text x="${(L + w + 8).toFixed(1)}" y="${yy + barH / 2 + 4}" class="val">${n}</text>`;
  });
  return `<figure class="chart"><figcaption class="chart-title">Когнитивные искажения · число эпизодов за период</figcaption>
<div class="chart-scroll"><div class="chart-box" style="min-width:600px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Топ когнитивных искажений">${g}</svg></div></div></figure>`;
}

// ---------- hours of day ----------
function hoursChart() {
  const W = 760, H = 190, L = 30, R = 10, T = 18, B = 26;
  const x0 = L, x1 = W - R, y0 = H - B;
  const hours = Array.from({ length: 24 }, (_, h) => S.hourCounts?.[h] || 0);
  const max = Math.max(...hours, 1);
  const bw = (x1 - x0) / 24 - 2;
  let g = '';
  hours.forEach((n, h) => {
    if (!n) return;
    const xx = x0 + h * ((x1 - x0) / 24) + 1;
    const hh = (n / max) * (y0 - T);
    const emph = n === max;
    g += `<path d="${roundedTopRect(xx, y0 - hh, bw, hh, 3)}" fill="${emph ? 'var(--accent-strong)' : 'var(--accent)'}" ${emph ? '' : 'opacity="0.65"'}><title>${h}:00–${h}:59 — ${n} записей</title></path>`;
    if (emph) g += `<text x="${(xx + bw / 2).toFixed(1)}" y="${(y0 - hh - 6).toFixed(1)}" text-anchor="middle" class="val">${n}</text>`;
  });
  for (const h of [0, 4, 8, 12, 16, 20]) {
    g += `<text x="${(x0 + h * ((x1 - x0) / 24) + bw / 2).toFixed(1)}" y="${y0 + 18}" text-anchor="middle" class="tick s">${h}:00</text>`;
  }
  g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="var(--baseline)" stroke-width="1"/>`;
  const t = `<details class="tw"><summary>Данные: записи по часам</summary><div class="tscroll"><table><thead><tr><th>Час</th><th>Записей</th></tr></thead><tbody>` +
    hours.map((n, h) => (n ? `<tr><td>${h}:00</td><td>${n}</td></tr>` : '')).join('') + `</tbody></table></div></details>`;
  return `<figure class="chart"><figcaption class="chart-title">Время записей · местное время</figcaption>
<div class="chart-scroll"><div class="chart-box" style="min-width:600px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Распределение записей по часам суток">${g}</svg></div></div>${t}</figure>`;
}

// ---------- wins per week ----------
function winsChart() {
  const weeks = Object.entries(S.winsPerWeek || {}).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (!weeks.length) return '';
  const W = 760, H = 170, L = 30, R = 10, T = 18, B = 26;
  const x0 = L, x1 = W - R, y0 = H - B;
  const max = Math.max(...weeks.map((w) => w[1]), 1);
  const bw = (x1 - x0) / weeks.length - 3;
  let g = '';
  weeks.forEach(([wk, n], i) => {
    const xx = x0 + i * ((x1 - x0) / weeks.length) + 1.5;
    const hh = (n / max) * (y0 - T);
    g += `<path d="${roundedTopRect(xx, y0 - hh, bw, hh, 3)}" fill="var(--accent)" opacity="0.8"><title>Неделя, заканчивающаяся ${wk}: ${n} побед</title></path>`;
    if (n === max) g += `<text x="${(xx + bw / 2).toFixed(1)}" y="${(y0 - hh - 6).toFixed(1)}" text-anchor="middle" class="val">${n}</text>`;
  });
  for (const [d, lab] of MONTH_TICKS.slice(1)) {
    const idx = weeks.findIndex(([wk]) => wk >= d);
    if (idx >= 0) g += `<text x="${(x0 + idx * ((x1 - x0) / weeks.length)).toFixed(1)}" y="${y0 + 18}" class="tick s">${lab}</text>`;
  }
  g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="var(--baseline)" stroke-width="1"/>`;
  return `<figure class="chart"><figcaption class="chart-title">«Победы недели», зафиксированные ботом · шт. в неделю</figcaption>
<div class="chart-scroll"><div class="chart-box" style="min-width:600px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Победы по неделям">${g}</svg></div></div></figure>`;
}


// ---------- recurring themes ("orbits") ----------
// Keys come from the bot's closed taxonomy; src/prompts/orbits.ts is the source of truth.
// Unknown keys fall through to the raw key, so a taxonomy change degrades gracefully.
const ORBIT_LABELS = {
  work_recognition: 'Признание на работе',
  partner_conflict: 'Конфликт и обида в паре',
  trigger_anger: 'Гнев на бытовые триггеры',
  life_passing: '«Жизнь проходит мимо»',
  self_labeling: 'Ярлыки на себя',
  health_worry: 'Здоровье и лечение',
  money_anxiety: 'Деньги',
  isolation: 'Одиночество и изоляция',
  uncertainty_control: 'Неопределённость и контроль',
};

function orbitsChart() {
  const data = (S.orbits || []).slice(0, 10);
  if (!data.length) return '';
  const max = data[0][1];
  const totalDays = S.kpi?.totalDaysInRange || 1;
  const W = 760, rowH = 32, barH = 19, L = 216, R = 78, T = 8;
  const H = T + data.length * rowH + 8;
  let g = '';
  data.forEach(([key, n], i) => {
    const name = ORBIT_LABELS[key] || key;
    const yy = T + i * rowH + (rowH - barH) / 2;
    const w = (n / max) * (W - L - R);
    const pct = Math.round((n / totalDays) * 100);
    g += `<text x="${L - 10}" y="${yy + barH / 2 + 4}" text-anchor="end" class="axis-label">${esc(name)}</text>`;
    g += `<path d="${roundedRightRect(L, yy, w, barH, 4)}" fill="var(--accent)" opacity="${i < 3 ? 1 : 0.6}"><title>${esc(name)}: ${n} дней (${pct}% дней периода)</title></path>`;
    g += `<text x="${(L + w + 8).toFixed(1)}" y="${yy + barH / 2 + 4}" class="val">${n} дн. · ${pct}%</text>`;
  });
  const months = Object.keys(S.orbitsByMonth || {}).sort();
  const table = months.length
    ? `<details class="tw"><summary>Данные: темы по месяцам (число записей)</summary><div class="tscroll"><table><thead><tr><th>Тема</th>` +
      months.map((m) => `<th>${m.slice(5)}</th>`).join('') + `</tr></thead><tbody>` +
      data.map(([key]) => `<tr><td>${esc(ORBIT_LABELS[key] || key)}</td>` +
        months.map((m) => {
          const row = (S.orbitsByMonth[m] || []).find((x) => x[0] === key);
          return `<td>${row ? row[1] : '—'}</td>`;
        }).join('') + `</tr>`).join('') +
      `</tbody></table></div></details>`
    : '';
  return `<figure class="chart"><figcaption class="chart-title">Темы, к которым дневник возвращается · в скольких разных днях тема появлялась<span class="chart-note">всего ${totalDays} дней в периоде</span></figcaption>
<div class="chart-scroll"><div class="chart-box" style="min-width:620px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Повторяющиеся темы дневника">${g}</svg></div></div>${table}</figure>`;
}

// ---------- distortions over time ----------
// Normalised per 10 entries of the month: raw counts would just re-draw how much was
// written that month, which is the one thing this chart must not be about.
function distortionTrendChart() {
  const byMonth = S.distortionsByMonth || {};
  const months = Object.keys(byMonth).sort();
  const vol = S.monthlyVolume || {};
  if (months.length < 2 || !Object.keys(vol).length) return '';
  const keys = (S.topDistortions || []).slice(0, 6).map((d) => d[0]);
  if (!keys.length) return '';
  const val = (m, k) => {
    const row = (byMonth[m] || []).find((x) => x[0] === k);
    const n = row ? row[1] : 0;
    return (n / (vol[m]?.entries || 1)) * 10;
  };
  const maxV = Math.max(...keys.flatMap((k) => months.map((m) => val(m, k))), 1);
  const W = 240, H = 132, L = 26, R = 8, T = 14, B = 22;
  const charts = keys.map((k) => {
    const x0 = L, x1 = W - R, y0 = H - B, y1 = T;
    const y = (v) => y0 - (v / maxV) * (y0 - y1);
    const step = months.length > 1 ? (x1 - x0) / (months.length - 1) : 0;
    let g = '';
    g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="var(--baseline)" stroke-width="1"/>`;
    g += `<line x1="${x0}" y1="${y(maxV)}" x2="${x1}" y2="${y(maxV)}" stroke="var(--grid)" stroke-width="1"/>`;
    const pts = months.map((m, i) => [x0 + i * step, y(val(m, k))]);
    g += `<path d="${pts.map((pt, i) => (i ? 'L' : 'M') + pt[0].toFixed(1) + ',' + pt[1].toFixed(1)).join('')}" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linejoin="round"/>`;
    pts.forEach((pt, i) => {
      g += `<circle cx="${pt[0].toFixed(1)}" cy="${pt[1].toFixed(1)}" r="2.6" fill="var(--accent)"><title>${months[i]}: ${f1(val(months[i], k))} на 10 записей</title></circle>`;
    });
    months.forEach((m, i) => {
      if (i !== 0 && i !== months.length - 1) return;
      g += `<text x="${(x0 + i * step).toFixed(1)}" y="${y0 + 15}" class="tick s" text-anchor="${i === 0 ? 'start' : 'end'}">${RU_MONTHS_SHORT[Number(m.slice(5)) - 1]}</text>`;
    });
    g += `<text x="${x0 - 5}" y="${y(maxV) + 3.5}" text-anchor="end" class="tick s">${f1(maxV)}</text>`;
    g += `<text x="${x0 - 5}" y="${y0 + 3.5}" text-anchor="end" class="tick s">0</text>`;
    return `<figure class="chart mini"><figcaption class="chart-title">${esc(cap(k))}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(k)} по месяцам">${g}</svg></figure>`;
  }).join('\n');
  const table = `<details class="tw"><summary>Данные: искажения по месяцам, на 10 записей</summary><div class="tscroll"><table><thead><tr><th>Искажение</th>` +
    months.map((m) => `<th>${m.slice(5)}</th>`).join('') + `</tr></thead><tbody>` +
    keys.map((k) => `<tr><td>${esc(cap(k))}</td>` + months.map((m) => `<td>${f1(val(m, k))}</td>`).join('') + `</tr>`).join('') +
    `</tbody></table></div></details>`;
  return `<div class="mini-row">${charts}</div><p class="footnote">Нормировано на объём: эпизодов на каждые 10 записей месяца — иначе самый многословный месяц выглядел бы самым искажённым.</p>${table}`;
}

// ---------- mean mood per month ----------
function monthlyMoodChart() {
  const data = (S.monthly || []).filter((m) => m.mood != null);
  if (!data.length) return '';
  const W = 760, H = 230, L = 34, R = 12, T = 24, B = 46;
  const x0 = L, x1 = W - R, y0 = H - B, y1 = T;
  const y = (v) => y0 - (v / 10) * (y0 - y1);
  const step = (x1 - x0) / data.length;
  const bw = Math.min(74, step - 16);
  const best = Math.max(...data.map((m) => m.mood));
  const worst = Math.min(...data.map((m) => m.mood));
  let g = '';
  for (const v of [0, 2, 4, 6, 8, 10]) {
    g += `<line x1="${x0}" y1="${y(v)}" x2="${x1}" y2="${y(v)}" stroke="var(--grid)" stroke-width="1"/>`;
    g += `<text x="${x0 - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${v}</text>`;
  }
  data.forEach((m, i) => {
    const xx = x0 + i * step + (step - bw) / 2;
    const hh = y0 - y(m.mood);
    g += `<path d="${roundedTopRect(xx, y(m.mood), bw, hh, 4)}" fill="${m.mood === worst ? 'var(--neg)' : 'var(--accent)'}" opacity="${m.mood === best ? 1 : 0.8}"><title>${m.month}: настроение ${f1(m.mood)}, дней ${m.days}</title></path>`;
    g += `<text x="${(xx + bw / 2).toFixed(1)}" y="${(y(m.mood) - 7).toFixed(1)}" text-anchor="middle" class="val">${f1(m.mood)}</text>`;
    g += `<text x="${(xx + bw / 2).toFixed(1)}" y="${y0 + 18}" text-anchor="middle" class="tick">${RU_MONTHS_SHORT[Number(m.month.slice(5)) - 1]}</text>`;
    g += `<text x="${(xx + bw / 2).toFixed(1)}" y="${y0 + 34}" text-anchor="middle" class="tick s">${m.days} дн.</text>`;
  });
  g += `<line x1="${x0}" y1="${y0}" x2="${x1}" y2="${y0}" stroke="var(--baseline)" stroke-width="1"/>`;
  return `<figure class="chart"><figcaption class="chart-title">Среднее настроение по месяцам, 0–10</figcaption>
<div class="chart-scroll"><div class="chart-box" style="min-width:600px"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Среднее настроение по месяцам">${g}</svg></div></div></figure>`;
}

// ---------- CSS ----------
// Design tokens: light + dark via prefers-color-scheme AND explicit
// data-theme overrides (so an in-page theme toggle can win either way).
const css = `
:root{
  --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --secondary:#52514e; --muted:#898781;
  --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,.10);
  --accent:#2a78d6; --accent-strong:#1c5cab; --neg:#e34948; --neutral-seg:#d6d5cd;
  --band:rgba(137,135,129,.09); --callout:#f2f1ec; --warn-edge:#ec835a;
}
@media (prefers-color-scheme: dark){:root{
  --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --secondary:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --baseline:#383835; --border:rgba(255,255,255,.10);
  --accent:#3987e5; --accent-strong:#6da7ec; --neg:#e66767; --neutral-seg:#3d3d3a;
  --band:rgba(137,135,129,.10); --callout:#222220; --warn-edge:#ec835a;
}}
:root[data-theme="light"]{
  --page:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --secondary:#52514e; --muted:#898781;
  --grid:#e1e0d9; --baseline:#c3c2b7; --border:rgba(11,11,11,.10);
  --accent:#2a78d6; --accent-strong:#1c5cab; --neg:#e34948; --neutral-seg:#d6d5cd;
  --band:rgba(137,135,129,.09); --callout:#f2f1ec; --warn-edge:#ec835a;
}
:root[data-theme="dark"]{
  --page:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --secondary:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --baseline:#383835; --border:rgba(255,255,255,.10);
  --accent:#3987e5; --accent-strong:#6da7ec; --neg:#e66767; --neutral-seg:#3d3d3a;
  --band:rgba(137,135,129,.10); --callout:#222220; --warn-edge:#ec835a;
}
*{box-sizing:border-box}
body{background:var(--page); color:var(--ink); font:16.5px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif; margin:0; padding:0 20px 80px;}
main{max-width:820px; margin:0 auto;}
section{margin-top:64px}
h1{font-size:clamp(28px,5vw,38px); line-height:1.15; letter-spacing:-0.01em; margin:10px 0 14px; text-wrap:balance}
h2{font-size:25px; line-height:1.25; margin:8px 0 18px; letter-spacing:-0.01em; text-wrap:balance}
h3{font-size:18px; margin:32px 0 10px}
p{margin:0 0 14px; max-width:70ch}
.eyebrow{font-size:12px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted); margin:0 0 4px; font-weight:600}
.hero{padding-top:56px}
.lede{font-size:18px; color:var(--secondary); max-width:64ch}
.kpi-row{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:10px; margin-top:28px}
.kpi{background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:14px 16px}
.kpi-label{font-size:12.5px; color:var(--muted)}
.kpi-value{font-size:22px; font-weight:600; margin:2px 0}
.kpi-sub{font-size:12.5px; color:var(--secondary)}
.callout{background:var(--callout); border:1px solid var(--border); border-radius:10px; padding:16px 20px; margin:22px 0}
.callout p{margin:0; max-width:none}
.callout.warn{border-left:3px solid var(--warn-edge)}
.chart{background:var(--surface); border:1px solid var(--border); border-radius:12px; padding:18px 18px 12px; margin:22px 0}
.chart-title{font-size:13.5px; font-weight:600; color:var(--secondary); margin-bottom:10px}
.chart-note{font-weight:400; color:var(--muted); margin-left:8px}
.chart-scroll{overflow-x:auto}
.chart svg{display:block; width:100%; height:auto}
.mini-row{display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:14px; margin:22px 0}
.mini{margin:0}
.tick{font-size:11.5px; fill:var(--muted); font-variant-numeric:tabular-nums}
.tick.s{font-size:10.5px}
.val{font-size:11.5px; fill:var(--secondary); font-variant-numeric:tabular-nums; font-weight:600}
.axis-label{font-size:12.5px; fill:var(--secondary)}
.event-label{font-size:11px; fill:var(--muted)}
.band-label{font-size:10.5px; fill:var(--muted); letter-spacing:.05em; text-transform:uppercase}
.neg-val{fill:var(--secondary)} .pos-val{fill:var(--secondary)}
.legend{display:flex; gap:18px; font-size:12.5px; color:var(--secondary); margin:8px 2px 0; flex-wrap:wrap}
.legend i{display:inline-block; width:10px; height:10px; border-radius:3px; margin-right:6px; vertical-align:-1px}
.footnote{font-size:12px; color:var(--muted); margin:8px 0 0}
.tw{margin-top:10px; font-size:13px}
.tw summary{color:var(--muted); cursor:pointer; font-size:12.5px}
.tscroll{overflow-x:auto; max-height:320px; overflow-y:auto; margin-top:8px; border:1px solid var(--border); border-radius:8px}
table{border-collapse:collapse; width:100%; font-variant-numeric:tabular-nums}
th,td{padding:5px 12px; text-align:left; border-bottom:1px solid var(--grid); white-space:nowrap}
th{position:sticky; top:0; background:var(--surface); font-size:12px; color:var(--muted)}
ul,ol{padding-left:22px; max-width:70ch}
li{margin-bottom:10px}
.strengths li,.axes li{margin-bottom:14px}
dl.distortion-list dt{font-weight:600; margin-top:18px}
dl.distortion-list dd{margin:6px 0 0 0; color:var(--secondary)}
.wins-grid{list-style:none; padding:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:10px; max-width:none}
.wins-grid li{background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:10px 14px; margin:0; font-size:14.5px}
.plan-list li{margin-bottom:16px}
.closing{font-size:18px; color:var(--ink); border-top:1px solid var(--grid); padding-top:22px; margin-top:30px}
.tip{position:fixed; pointer-events:none; background:var(--surface); border:1px solid var(--border); border-radius:8px; padding:8px 12px; font-size:12.5px; box-shadow:0 4px 14px rgba(0,0,0,.12); z-index:10; max-width:220px}
.tip b{font-variant-numeric:tabular-nums}
@media (prefers-reduced-motion: no-preference){ .chart{scroll-behavior:smooth} }
`;

// ---------- JS (mood chart hover tooltip) ----------
const js = `
(function(){
  var fig=document.getElementById('mood-chart'); if(!fig) return;
  var data=JSON.parse(document.getElementById('mood-data').textContent);
  var svg=fig.querySelector('svg'), ov=document.getElementById('mood-overlay'),
      cross=document.getElementById('mood-cross'), tip=document.getElementById('mood-tip');
  function fmt(d){var p=d.split('-');return p[2]+'.'+p[1];}
  function move(ev){
    var pt=svg.createSVGPoint(); pt.x=ev.clientX; pt.y=ev.clientY;
    var loc=pt.matrixTransform(svg.getScreenCTM().inverse());
    var best=null,bd=1e9;
    for(var i=0;i<data.pts.length;i++){var dd=Math.abs(data.pts[i].x-loc.x); if(dd<bd){bd=dd;best=data.pts[i];}}
    if(!best){return;}
    cross.setAttribute('x1',best.x); cross.setAttribute('x2',best.x); cross.setAttribute('opacity','1');
    tip.hidden=false;
    tip.innerHTML='<b>'+fmt(best.d)+'</b> · настроение <b>'+String(best.m).replace('.',',')+'</b>'+(best.r!=null?'<br>среднее 7 дн.: <b>'+String(best.r).replace('.',',')+'</b>':'');
    var vw=window.innerWidth;
    var tx=ev.clientX+14; if(tx+240>vw) tx=ev.clientX-250;
    tip.style.left=tx+'px'; tip.style.top=(ev.clientY+14)+'px';
  }
  function leave(){cross.setAttribute('opacity','0'); tip.hidden=true;}
  ov.addEventListener('mousemove',move); ov.addEventListener('mouseleave',leave);
  ov.addEventListener('touchstart',function(e){if(e.touches[0])move(e.touches[0]);},{passive:true});
})();
`;

// ---------- assemble ----------
const body = prose
  .replace('{{KPI_ROW}}', kpiRow())
  .replace('{{CHART_MOOD}}', moodChart())
  .replace('{{CHART_SMALL_MULTIPLES}}', smallMultiples())
  .replace('{{CHART_SENTIMENT}}', sentimentChart())
  .replace('{{CHART_DISTORTIONS}}', distortionsChart())
  .replace('{{CHART_HOURS}}', hoursChart())
  .replace('{{CHART_WINS}}', winsChart())
  .replace('{{CHART_MONTHLY_MOOD}}', monthlyMoodChart())
  .replace('{{CHART_ORBITS}}', orbitsChart())
  .replace('{{CHART_DISTORTION_TREND}}', distortionTrendChart());

const html = `<title>${esc(pageTitle)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>${css}</style>
<main>
${body}
</main>
<script>${js}</script>`;

fs.writeFileSync(outPath, html);
const leftover = html.match(/\{\{[A-Z_]+\}\}/g);
console.log(`Wrote ${outPath} (${html.length} chars); leftover placeholders: ${leftover ? leftover.join(', ') : 'none'}`);
