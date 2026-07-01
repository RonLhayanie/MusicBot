# MusicBot

## Overview
A personal Telegram + Siri voice assistant for discovering and saving music to Spotify. A user sends a free-text message (or a voice command via an iOS Shortcut) describing what they want to hear — including associative/historical requests like "50s blues that influenced Jimi Hendrix" — and Gemini acts as a music historian/curator to return real, verifiable songs, which the user can then inject straight into their Spotify library with one tap.

## Tech Stack
- **Runtime**: Node.js (CommonJS, `type: commonjs` in package.json:12)
- **Telegram bot**: `node-telegram-bot-api` (long polling)
- **AI**: Google Gemini (`@google/generative-ai`, model `gemini-2.5-flash`, with Google Search grounding for the research flow)
- **Music backend**: Spotify Web API via `axios` (OAuth refresh-token flow)
- **HTTP server**: `express` — serves the Spotify OAuth callback and a `/api/siri` webhook for iOS Shortcuts
- **Config**: `.env` via `dotenv`

## Project Structure
This is a single-file project — there is no `src/` tree yet:
- `index.js` — the entire application: Spotify client functions, Gemini prompt functions, Telegram listeners, and the Express server/OAuth routes. See index.js:1 for the full layout.
- `.env` — required secrets (not committed): `TELEGRAM_TOKEN`, `GEMINI_API_KEY`, `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`, `SPOTIFY_REFRESH_TOKEN`.

## Running the Project
```
npm install
node index.js
```
- Starts the Telegram bot (polling) and an Express server on port 8888 (index.js:19, index.js:355).
- To (re)generate a Spotify refresh token: visit `/login`, complete the Spotify auth flow, then copy the refresh token printed to the terminal at `/callback` into `.env` (index.js:317-353).
- `/debug` (Telegram command) prints the currently connected Spotify account to the terminal (index.js:188-202).

## Tests
No test suite exists yet (`npm test` is a placeholder, package.json:7). If you add tests, update this section with the real command.

## Additional Documentation
- [.claude/docs/architectural_patterns.md](.claude/docs/architectural_patterns.md) — recurring patterns to follow when extending the bot: prompt/JSON contracts for Gemini calls, retry strategy, the Telegram inline-keyboard confirm/skip flow, the two-stage Spotify search, and the OAuth refresh-token bootstrap.
