# Psychologist Bot

A CBT (Cognitive Behavioral Therapy) voice diary Telegram bot. Post voice or text entries to a Telegram channel, and the bot transcribes, analyzes them using LLM with CBT techniques, and enables follow-up conversations in threads.

## Features

- **Voice diary** — post voice messages to a Telegram channel, automatically transcribed via ElevenLabs Scribe (with OpenAI fallback)
- **CBT analysis** — each entry is analyzed for cognitive distortions, gratitude moments, action items, and sentiment
- **Thread conversations** — reply in discussion threads to chat with the bot about your entry using CBT techniques
- **Compare mode** — run multiple LLM providers (Claude + OpenAI) in parallel and compare responses side-by-side
- **Weekly/monthly reports** — automatic scheduled reports + on-demand via `/weekly` and `/monthly` channel commands
- **Metrics tracking** — self-reported mood, anxiety, energy (0-10) extracted from entries
- **Cost tracking** — per-call cost display for both ASR and LLM
- **Smart context fitting** — reports include transcripts + LLM analyses, with automatic truncation for large contexts
- **Bilingual** — Russian and English support (configurable)

## Architecture

- **Runtime**: Node.js + TypeScript (ESM)
- **Telegram**: [grammy](https://grammy.dev/)
- **Database**: SQLite via better-sqlite3
- **ASR**: ElevenLabs Scribe v2 (primary) / OpenAI Transcribe (fallback)
- **LLM**: Claude Sonnet 4.6 / OpenAI GPT-5.4
- **Scheduler**: node-cron for daily reminders, weekly and monthly reports

## Setup

1. Clone the repo
2. Install dependencies:
   ```bash
   npm install
   ```
3. Copy `.env.example` to `.env` and fill in your API keys:
   ```bash
   cp .env.example .env
   ```
4. Create a Telegram bot via [@BotFather](https://t.me/BotFather)
5. Create a Telegram channel with a linked discussion group
6. Add the bot as admin to both channel and discussion group
7. Run the bot:
   ```bash
   npm run dev    # development (tsx watch)
   npm run build  # compile TypeScript
   npm start      # production
   ```

## Configuration

All configuration is done via environment variables. See [.env.example](.env.example) for all options.

Key settings:
- `ASR_PROVIDER` — `elevenlabs` or `openai`
- `LLM_PROVIDER` — `claude` or `openai`
- `COMPARE_MODE` — `true` to run all LLM providers in parallel
- `BOT_LANGUAGE` — `ru` or `en`

## Channel Commands

- `/weekly` — generate a test weekly report (Monday → today)
- `/monthly` — generate a test monthly report (1st → today)

## How It Works

1. You post a voice/text message to the Telegram channel
2. The bot transcribes voice messages using ElevenLabs ASR
3. LLM analyzes the entry for cognitive distortions, sentiment, gratitude
4. Transcript and analysis appear in the discussion group thread
5. You can reply in the thread to continue a CBT conversation
6. Weekly/monthly reports aggregate your entries with smart context fitting

## License

MIT
