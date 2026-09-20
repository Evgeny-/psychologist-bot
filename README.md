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
- **Weekly letter** — on Monday the bot writes a short letter about the week: the week named in one line, what you did in your own words with dates (this is the week's credit — you remember your verdicts on yourself and forget your actions), one observation about what you did or thought that connects at least two days, and what is still hanging. No counters, no empty sections, no closing question. Two earlier formats failed in opposite directions — a 7,500-character retelling, then a seven-section skeleton of counters — and the letter replaces both. There is no morning message: three morning formats were tried and none got a word back
- **Say this out loud** — when an entry carries a charged verdict about yourself ("I have problems with this", "I should have"), the reply quotes it back and offers one short sentence to say instead. Not the opposite of what you said — repeating a sentence you don't believe produces counter-argument rather than comfort — only a more precise one: this episode instead of the whole person, today instead of always. Second person, by name when `BOT_USER_NAME` is set. Never fires on statements about other people
- **Vetoes** — `/veto <text>` permanently blacklists a topic or phrasing. The list goes into every weekly and monthly prompt verbatim and never expires; `/veto` lists them, `/veto -3` removes one
- **External credits** — what other people did in response to you or for you (a reply, an offer of help, a dinner cooked, an invitation) is stored separately from your own wins and mentioned in the weekly and monthly letters — only when there is something; the letters never say "none recorded"
- **Short-term memory** — compact daily summaries for the last 10 days, used in new analyses and thread replies
- **Compare mode** — run Claude + OpenAI in parallel, see both analyses side by side
- **Monthly letter** — the same shape over four weeks, opening on what has not moved. Both letters come with an attached 30-day metrics chart (rendered locally, with missing days shown by absent markers)
- **Metrics** — mood, anxiety, stress, productivity, routine (0-10), extracted from your speech
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
| `/veto` | List standing "never raise this again" instructions |
| `/veto <text>` | Add one; `/veto -3` removes it by number |
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
- `BOT_LANGUAGE` — `ru` or `en`. Covers both halves: every system prompt has a Russian and an English variant, and all bot-facing text (headings, report titles, reminders) comes from `src/i18n/`. Adding a user-facing string means adding it to `ru.ts`, `en.ts` and the `Strings` interface — never inline it in a service.
- `BOT_USER_NAME` — optional first name, used only to address you in the say-this-out-loud line. Left unset, it falls back to plain second person
- `BOT_TIMEZONE` — for correct date calculations (e.g. `Europe/Amsterdam`)

Scheduled jobs use `BOT_TIMEZONE`: the 20:30 reminder, the 23:55 memory consolidation, the weekly letter on Monday at 10:00 and the monthly one on the 1st at 10:00.

`EVENING_FROM_HOUR` in `src/config.ts` is the hour from which an entry counts as summing the day up. Two things read it and must not drift apart: the 20:30 reminder skips days that already have an entry from that hour on, and the daily prompt refuses to infer metrics from a word description written earlier — mornings describe a day not yet lived.

Runtime logs are written both to stdout/journald and to `logs/app.log` in logfmt-style single-line entries, so stage timings can be grepped without digging through raw stack traces.

For voice replies:
- Set `ELEVENLABS_TTS_VOICE_ID` if you want ElevenLabs TTS as the primary voice provider
- Or rely on OpenAI TTS fallback with `OPENAI_TTS_MODEL` and `OPENAI_TTS_VOICE`

## Tech Stack

TypeScript, Node.js (ESM), [grammy](https://grammy.dev/), SQLite (better-sqlite3), node-cron, ElevenLabs Scribe v2, Claude Sonnet 4.6, OpenAI GPT-5.4 mini

## License

MIT
