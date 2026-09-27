// An offline documentation example. Never read .env or the diary database.
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DOTENV_CONFIG_PATH = '/dev/null';
process.env.DB_PATH = ':memory:';
process.env.TELEGRAM_BOT_TOKEN = 'documentation-only';
process.env.BOT_LANGUAGE = 'en';

const { queries, db } = await import('../src/db/index.js');
const { renderMetricsChart } = await import('../src/services/charts.js');
const { en } = await import('../src/i18n/en.js');
en.chartTitle = 'Example diary · {days} days · fictional data';

// Deliberately uneven, with missed days. These are illustrative values, not outcomes.
for (let day = 1; day <= 30; day++) {
  if ([5, 6, 13, 21, 26].includes(day)) continue;
  queries.insertMetrics({
    date: `2026-06-${String(day).padStart(2, '0')}`,
    mood: [6, 5, 7, 4, 6, 8, 5][day % 7],
    anxiety: [3, 5, 4, 6, 3, 2, 5][day % 7],
    stress: [4, 6, 3, 5, 7, 2][day % 6],
    productivity: [5, 7, 4, 6, 3][day % 5],
    routine: [6, 7, 5, 8, 6, 4][day % 6],
  });
}
const png = renderMetricsChart('2026-06-30');
if (!png) throw new Error('Documentation chart did not render');
const output = fileURLToPath(new URL('../docs/images/metrics-example.png', import.meta.url));
mkdirSync(fileURLToPath(new URL('../docs/images/', import.meta.url)), { recursive: true });
writeFileSync(output, png);
db.close();
console.log(`Wrote ${output}`);
