# MusicBot

A Telegram bot and HTTP service that controls Spotify playback and curates music using Gemini.
It is driven two ways: by chatting with the Telegram bot at home, and by voice through an iOS
Siri Shortcut that posts to the bot's HTTP API while driving.

Built for a single user and deployed on Railway.

## What it does

**Music research.** Send a free-text request ("something like early Radiohead but calmer") and
Gemini returns a set of songs. Each is looked up on Spotify and sent back as a Telegram card
with inline buttons: add to Liked Songs, play now on an active device, or skip. Tracks that
have no Spotify match are reported rather than silently dropped.

**Voice control.** An iOS Shortcut posts the dictated command to `POST /api/siri`. Gemini parses
it into a structured intent (play, pause, skip, save, research, lyrics lookup) plus a search
query; the server executes it against the Spotify Web API and returns Hebrew speech text for
Siri to read back.

**Lyrics lookup.** Given a remembered lyric, Gemini proposes a song and the server verifies it
against Spotify search before offering it. Because a wrong guess is worse than no guess, the
result is confirmed with the user in a second conversational turn before anything plays.

**Driving session.** A queue of researched tracks the bot advances through, so a single voice
command can keep music going without further interaction.

**Weekly summary.** A cron job runs every Sunday at 09:00 Asia/Jerusalem and pushes a Telegram
message summarising the tracks saved that week.

## Stack

- Node.js, Express
- `node-telegram-bot-api` (long polling)
- `@google/generative-ai` (Gemini)
- Spotify Web API over `axios`
- MongoDB via `mongoose`
- `node-cron`
- Deployed on Railway

## HTTP endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | Health check |
| `GET` | `/login` | Starts the Spotify OAuth consent flow |
| `GET` | `/callback` | OAuth callback; prints the refresh token for one-time setup |
| `POST` | `/api/siri` | Main voice command endpoint used by the Siri Shortcut |
| `POST` | `/api/save-current` | Saves the currently playing track to Liked Songs |
| `POST` | `/api/save-shazam` | Saves a track identified by title and artist |

The server listens on port 8888.

## Setup

```bash
npm install
cp .env.example .env
```

Fill in `.env`. `SPOTIFY_REFRESH_TOKEN` is obtained once:

1. Register a Spotify app and add your redirect URI to it
2. Start the server: `node index.js`
3. Open `http://127.0.0.1:8888/login` and approve the requested scopes
4. Copy the refresh token printed in your terminal into `SPOTIFY_REFRESH_TOKEN`
5. Restart

Run it with:

```bash
node index.js
```

The bot will not start polling or accept HTTP traffic until MongoDB connects. On failure it
logs and exits, rather than running in a degraded state.

## Persistence and access control

Two Mongo collections back the parts that must survive a redeploy, since Railway's filesystem
is ephemeral:

- `BotConfig` - a singleton document holding the Telegram chat ID that dashboard notifications
  are pushed to
- `HistoryEntry` - a log of added, played and toggled tracks, used to build the weekly summary
  and to seed recommendations

Set `TELEGRAM_OWNER_CHAT_ID` to lock the bot to your own chat. Without it the bot falls back to
a claim-once scheme where the first chat to message it becomes the notification target, which
is safe after the first message but has a bootstrap race on a fresh deploy.

## Error handling

Gemini calls retry up to three times with a doubling delay, except on quota exhaustion, which
fails immediately rather than burning retries. A process-level `unhandledRejection` handler logs
and recovers instead of letting Node terminate the process over one uncaught async error in a
background path.

## Language

Code, comments and log output are English. Text the user hears or reads is Hebrew: Siri speech
responses, Telegram replies and button labels. Emoji appear only in user-facing messages.

## Known limitations

- The whole application is one 1,347-line `index.js`. Splitting the Spotify client, the Gemini
  layer, the Telegram handlers and the HTTP routes into modules is the obvious next step.
- Driving-session state is held in memory and is lost on restart.
- The port is hardcoded to 8888.
- `GET /callback` prints a Spotify refresh token to stdout. It is a one-time local setup step,
  but it means that route should never be exercised on a host whose stdout is collected into a
  shared log system.
- `/debug` logs the connected Spotify account's email address.
- Single-user by design: there is no per-user session or token storage.
