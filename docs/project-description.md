# Project description

GitHub About text:

> Talk through your day in a Telegram voice note. Get CBT reflections and letters that draw on earlier entries.

Portfolio copy:

> A voice diary in Telegram. Tell it how your day went, then talk it through with a CBT bot that remembers earlier entries. Weekly and monthly letters help you see what keeps coming up.

## Documentation images

`images/diary-flow.svg` shows a daily voice note with an excerpt of its transcript and a follow-up question in Telegram. All dialogue is fictional.

`images/metrics-example.png` comes from the production chart renderer with an in-memory database of deterministic fictional values. Regenerate it with:

```sh
npx tsx scripts/render-docs-chart.ts
```

The script disables dotenv loading, opens only an in-memory database and makes no API calls. It uses the repository's existing font and renderer. No diary exports, logs or credentials are used as image inputs.

Source references: `src/services/analysis.ts`, `chat.ts`, `memory-context.ts`, `similarity.ts`, `orbits.ts`, `reports.ts`, `charts.ts`, and `src/bot.ts`.
