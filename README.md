# Psychologist Bot

A personal CBT (Cognitive Behavioral Therapy) voice diary bot for Telegram. Record your thoughts, get instant psychological analysis, and have follow-up conversations — all inside a private Telegram channel.

## What it does

You record a voice message in your Telegram channel about your day. The bot transcribes it, runs a CBT-style analysis (detects cognitive distortions, tracks gratitude, notes action items), and posts the results. You can then reply in the thread to discuss your thoughts further — the bot keeps the full conversation context.

Multiple entries per day? The bot sees your earlier entries as reference, so it can track how your thinking evolved throughout the day.

## Features

- **Voice diary** — post voice messages, auto-transcribed via ElevenLabs Scribe (OpenAI fallback if balance runs out)
- **CBT analysis** — cognitive distortions, sentiment, gratitude, action items
- **Thread conversations** — reply to discuss your entry using CBT techniques (Socratic dialogue, reframing)
- **Audio replies on demand** — ask the bot to answer by voice/audio and it will synthesize the reply
- **Same-day context** — later entries include earlier ones as reference, so the model sees the full picture
- **Morning brief** — every morning the bot posts a short carry-over note to the main channel based on yesterday's diary context
- **Short-term memory** — compact daily summaries for the last 10 days, used in new analyses and thread replies
- **Compare mode** — run Claude + OpenAI in parallel, see both analyses side by side
- **Reports** — weekly and monthly summaries with smart context fitting
- **Metrics** — mood, anxiety, stress, productivity (0-10), extracted from your speech
- **Streak tracking** — consecutive days with entries
- **CSV export** — download your diary data
- **Cost tracking** — see per-call ASR and LLM costs
- **Bilingual** — Russian and English

## Channel Commands

Type these in the **channel** (not the discussion group):

| Command | What it does |
|---------|-------------|
| `/weekly` | Generate weekly report (Monday → today) |
| `/monthly` | Generate monthly report (1st → today) |
| `/morning` | Generate today's morning brief manually |
| `/stats` | Show streak, entry count, average metrics |
| `/export` | Download all entries as CSV |
| `/memory` | Show long-term memory |
| `/recentmemory` | Show short-term daily memory |
| `/generatememory` | Regenerate long-term memory |
| `/generaterecentmemory` | Regenerate short-term memory for the last 10 days |

## Setup

```bash
# 1. Clone and install
git clone https://github.com/Evgeny-/psychologist-bot.git
cd psychologist-bot
npm install

# 2. Configure
cp .env.example .env
# Edit .env with your API keys and Telegram IDs

# 3. Run
npm run dev    # development (auto-reload)
npm run build  # compile
npm start      # production
```

You'll need:
- A Telegram bot ([@BotFather](https://t.me/BotFather))
- A private Telegram channel with a linked discussion group
- Bot added as admin to both
- API keys for at least one LLM (Anthropic or OpenAI) and one ASR (ElevenLabs or OpenAI)

## Configuration

All settings via environment variables — see [.env.example](.env.example).

Key ones:
- `LLM_PROVIDER` — `claude` or `openai`
- `ASR_PROVIDER` — `elevenlabs` or `openai`
- `TTS_PROVIDER` — `elevenlabs` or `openai`
- `COMPARE_MODE=true` — run all LLM providers in parallel
- `BOT_LANGUAGE` — `ru` or `en`
- `BOT_TIMEZONE` — for correct date calculations (e.g. `Europe/Amsterdam`)

Scheduled jobs use `BOT_TIMEZONE`, including the daily morning brief at 08:00.

Runtime logs are written both to stdout/journald and to `logs/app.log` in logfmt-style single-line entries, so stage timings can be grepped without digging through raw stack traces.

For voice replies:
- Set `ELEVENLABS_TTS_VOICE_ID` if you want ElevenLabs TTS as the primary voice provider
- Or rely on OpenAI TTS fallback with `OPENAI_TTS_MODEL` and `OPENAI_TTS_VOICE`

## Tech Stack

TypeScript, Node.js (ESM), [grammy](https://grammy.dev/), SQLite (better-sqlite3), node-cron, ElevenLabs Scribe v2, Claude Sonnet 4.6, OpenAI GPT-5.4 mini

## License

MIT
