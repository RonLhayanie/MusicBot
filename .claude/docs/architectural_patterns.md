# Architectural Patterns

## Single-file, section-commented module
Everything lives in `index.js`, organized into banner-commented sections (`// --- Spotify Functions ---`, `// --- Gemini AI Functions ---`, `// --- Telegram Listeners ---`, `// --- Server & Spotify OAuth ---`). When adding functionality, extend the matching section rather than scattering related logic — see index.js:23, index.js:105, index.js:183, index.js:278.

## Env-var configuration, no config module
All secrets/config are read once at the top of the file straight from `process.env` after `dotenv.config()` (index.js:1-14). There is no config abstraction layer — new integrations should follow the same pattern: add the var to `.env`, read it into a top-level `const`, and reference that constant.

## AI-as-parser: prompt → strict JSON contract
Both Gemini call sites (`parseSiriCommand` at index.js:106 and `researchMusic` at index.js:136) follow the same contract: a prompt that ends with an explicit "return ONLY valid JSON in this exact shape" instruction, followed by stripping markdown fences (`` ```json ``) before `JSON.parse`. Any new AI-driven feature should reuse this prompt→strip-fences→parse pattern rather than trying to parse free-form text.

## Retry with exponential backoff for AI calls
`researchMusic` (index.js:136-181) wraps its Gemini call in a manual retry loop that only retries on HTTP 503/429, doubling `delay` each attempt. `parseSiriCommand` intentionally does not retry (single Siri request/response cycle). Follow the same selective-retry approach for new external calls that can be rate-limited or overloaded — don't blanket-retry every error.

## Two-stage Spotify track search (fuzzy → strict)
`searchSpotifyTrack` (index.js:52-90) first tries a broad free-text query and checks for fuzzy title/artist substring matches; if nothing matches, it falls back to Spotify's `track:`/`artist:` field-search syntax. New Spotify search logic should keep this fallback shape rather than relying on a single query strategy, since AI-generated titles/artists don't always match Spotify's exact strings.

## Telegram inline-keyboard confirm/skip flow
User-facing song suggestions are always delivered as a message plus an inline keyboard with two `callback_data` actions: `add_<title>|<artist>` and `skip` (index.js:220-232), handled centrally in the single `bot.on('callback_query', ...)` listener (index.js:240-276) by branching on the `callback_data` prefix. New interactive actions should add a new `callback_data` prefix and a branch in that same listener rather than creating additional listeners.

## Dual entry points into the same intent space (chat vs. voice)
Two independent input channels drive the app: free-text Telegram messages (index.js:204-238) for conversational music research, and the `/api/siri` POST endpoint (index.js:283-315) for voice commands relayed from an iOS Shortcut. They intentionally use different Gemini prompts/output shapes (`researchMusic`'s song list vs. `parseSiriCommand`'s intent classification) because they solve different problems — don't try to unify them into one prompt.

## OAuth token flow: manual refresh-token bootstrap
Spotify auth is refresh-token based: `/login` (index.js:317) redirects to Spotify's authorize screen, `/callback` (index.js:330) exchanges the returned code for a refresh token and logs it to the console for the developer to copy into `.env` manually. There is no persistent token storage — `getSpotifyAccessToken` (index.js:24-38) exchanges the `.env` refresh token for a fresh access token on every Spotify API call. Don't introduce token caching without also handling expiry.
