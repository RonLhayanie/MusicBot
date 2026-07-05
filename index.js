require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const querystring = require('querystring');
const axios = require('axios');
const mongoose = require('mongoose');
const cron = require('node-cron');

// Setup from .env
const token = process.env.TELEGRAM_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
// Optional but recommended: locks dashboard notifications to one specific Telegram chat
// so no other chat that messages the bot can silently steal the notification destination.
// If unset, falls back to a "claim once" scheme (see bot.on('message') below) — safer than
// the old unconditional overwrite, but has a bootstrap race on a brand-new deploy (whoever
// messages first wins). Set this in Railway's env vars for full protection.
const TELEGRAM_OWNER_CHAT_ID = process.env.TELEGRAM_OWNER_CHAT_ID
    ? Number(process.env.TELEGRAM_OWNER_CHAT_ID)
    : null;

// polling/listening are only started once MongoDB connects successfully (see start() below) —
// Railway's filesystem is ephemeral, so this app should not accept traffic without its DB
const bot = new TelegramBot(token, { polling: false });
const app = express();
app.use(express.json()); // required to receive JSON commands from the iOS Siri Shortcut
const PORT = 8888;

// Defense-in-depth: modern Node terminates the process on an unhandled rejection by
// default. pushDashboardUpdate/getDashboardChatId are hardened not to reject at all, but
// this is a last-resort net for anything else in the background-processing paths that
// isn't awaited — a Railway deploy shouldn't go down over one uncaught async error.
process.on('unhandledRejection', (reason) => {
    console.error("Unhandled promise rejection (recovered):", reason);
});

console.log("Music bot is on air");

// --- MongoDB / Persistence ---
// Anything that must survive a Railway redeploy (which chat to push Siri dashboard
// updates to, and liked-track history) lives here instead of in-memory or on disk.
const botConfigSchema = new mongoose.Schema({
    _id: { type: String, default: 'singleton' },
    dashboardChatId: { type: Number, default: null }
});
const BotConfig = mongoose.model('BotConfig', botConfigSchema);

const historyEntrySchema = new mongoose.Schema({
    type: { type: String, enum: ['added', 'played', 'toggled'], required: true },
    trackId: { type: String, required: true },
    title: { type: String, required: true },
    artist: { type: String, required: true }
}, { timestamps: true });
const HistoryEntry = mongoose.model('HistoryEntry', historyEntrySchema);

// --- Spotify Functions ---
async function getSpotifyAccessToken() {
    const response = await axios({
        method: 'post',
        url: 'https://accounts.spotify.com/api/token',
        data: querystring.stringify({
            grant_type: 'refresh_token',
            refresh_token: SPOTIFY_REFRESH_TOKEN
        }),
        headers: {
            'content-type': 'application/x-www-form-urlencoded',
            'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
        }
    });
    return response.data.access_token;
}

// Debug helper to inspect the connected Spotify account
async function getSpotifyUserProfile(accessToken) {
    try {
        const response = await axios.get('https://api.spotify.com/v1/me', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        return response.data;
    } catch (error) {
        return null;
    }
}

// Strips parenthetical/bracketed text (transliterations, translations) that Spotify's
// search chokes on — a defensive fallback in case Gemini adds them despite the prompt rules
function sanitizeSearchText(text) {
    return text.replace(/[\(\[][^)\]]*[\)\]]/g, '').trim();
}

// Returns the matched Spotify track object (not just the ID) so callers can also
// read preview_url/name/artists without a second lookup.
async function searchSpotifyTrack(accessToken, title, artist) {
    title = sanitizeSearchText(title);
    artist = sanitizeSearchText(artist);

    // Step 1: broad free-text search
    const query = encodeURIComponent(`${title} ${artist}`);
    const response = await axios.get(`https://api.spotify.com/v1/search?q=${query}&type=track&limit=10`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (response.data.tracks.items.length > 0) {
        for (let track of response.data.tracks.items) {
            const artistMatch = track.artists.some(a =>
                a.name.toLowerCase().includes(artist.toLowerCase()) ||
                artist.toLowerCase().includes(a.name.toLowerCase())
            );

            if (artistMatch && (track.name.toLowerCase().includes(title.toLowerCase()) || title.toLowerCase().includes(track.name.toLowerCase()))) {
                return track;
            }
        }
    }

    // Step 2: explicit field tags for numbers, etc.
    const strictQuery = encodeURIComponent(`track:${title} artist:${artist}`);
    const strictResponse = await axios.get(`https://api.spotify.com/v1/search?q=${strictQuery}&type=track&limit=3`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (strictResponse.data.tracks.items.length > 0) {
        for (let track of strictResponse.data.tracks.items) {
             const artistMatch = track.artists.some(a =>
                a.name.toLowerCase().includes(artist.toLowerCase()) ||
                artist.toLowerCase().includes(a.name.toLowerCase())
            );
            if (artistMatch) return track;
        }
        return strictResponse.data.tracks.items[0];
    }

    return null;
}

// Fetches a track's full details by ID (used when a callback only carries a track ID).
async function getTrackInfo(accessToken, trackId) {
    const response = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    return response.data;
}

// Injects a track into the user's Spotify library
async function saveTrackToLibrary(accessToken, trackId) {
    // Spotify replaced /me/tracks with /me/library and requires a dedicated uri param
    await axios({
        method: 'put',
        url: `https://api.spotify.com/v1/me/library?uris=spotify:track:${trackId}`,
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });
}

// Removes a track from the user's Spotify library (mirrors saveTrackToLibrary)
async function removeTrackFromLibrary(accessToken, trackId) {
    await axios({
        method: 'delete',
        url: `https://api.spotify.com/v1/me/library?uris=spotify:track:${trackId}`,
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
}

// Returns the user's currently active device, or the first available device
// if none is marked active (e.g. Spotify is open but idle). Returns null if
// no devices are available at all.
async function getActiveDevice(accessToken) {
    const response = await axios.get('https://api.spotify.com/v1/me/player/devices', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const devices = response.data.devices || [];
    return devices.find(d => d.is_active) || devices[0] || null;
}

// Starts/resumes playback of a single track on the given device
async function playTrackOnDevice(accessToken, trackId, deviceId) {
    await axios({
        method: 'put',
        url: `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
        data: { uris: [`spotify:track:${trackId}`] },
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });
}

async function pausePlaybackOnDevice(accessToken, deviceId) {
    await axios({
        method: 'put',
        url: `https://api.spotify.com/v1/me/player/pause?device_id=${deviceId}`,
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
}

async function skipToNextOnDevice(accessToken, deviceId) {
    await axios({
        method: 'post',
        url: `https://api.spotify.com/v1/me/player/next?device_id=${deviceId}`,
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
}

// Resumes whatever was paused, unlike playTrackOnDevice which always starts a specific track
async function resumePlaybackOnDevice(accessToken, deviceId) {
    await axios({
        method: 'put',
        url: `https://api.spotify.com/v1/me/player/play?device_id=${deviceId}`,
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
}

// Single /me/player call returning both the active device and play state — Spotify's
// response already has both, so callers needing both don't need two separate requests
// (getActiveDevice + a second call) like the toggle_ handler used to make.
async function getPlaybackState(accessToken) {
    const response = await axios.get('https://api.spotify.com/v1/me/player', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    }).catch(() => null);
    return {
        device: response?.data?.device ?? null,
        isPlaying: Boolean(response?.data?.is_playing)
    };
}

// Returns the full Spotify track object for whatever's currently playing, or null if
// nothing is (204 No Content) OR if what's playing isn't a track (podcast episode/ad —
// those have no .artists array, so treating them as a track crashes the caller).
async function getCurrentlyPlayingTrack(accessToken) {
    const response = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (response.status === 204 || !response.data?.item) return null;
    if (response.data.currently_playing_type !== 'track') return null;
    return response.data.item;
}

// Finds an active device and plays a track there. Returns the device on success,
// null if none is available (caller shows a graceful message).
async function tryPlayTrack(accessToken, trackId) {
    const device = await getActiveDevice(accessToken);
    if (!device) return null;
    await playTrackOnDevice(accessToken, trackId, device.id);
    console.log(`Now playing track ${trackId} on device: ${device.name}`);
    return device;
}

// Appends a track to the device's playback queue. Playlist-content-mutation endpoints
// (create/add-to-playlist) 403 in Spotify's Development Mode for this app even with
// correct scopes and an allowlisted account, so drive-time sessions are built from
// queued/played tracks + Liked Songs saves instead of a real Spotify playlist object.
async function queueTrackOnDevice(accessToken, trackId, deviceId) {
    await axios.post(`https://api.spotify.com/v1/me/player/queue?uri=spotify:track:${trackId}&device_id=${deviceId}`, null, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
}

// --- Driving Session State (Interactive Playlist) ---
// Single-user bot, so a module-level variable is enough state — no session ID/store needed.
// Shape: { tracks: [{ trackId, title, artist }], currentIndex }
let currentSession = null;

// Chat to push live driving-log updates to. Captured automatically from the user's own
// Telegram messages (see bot.on('message') below) since the Siri webhook has no chat
// context of its own. Always read fresh from Mongo (not cached in-memory) so this stays
// correct regardless of process restarts or which code path is asking.
// Never throws/rejects — every call site below fires this without awaiting it, so it
// must swallow its own failures (Mongo hiccup, Telegram send failure) rather than
// leave an unhandled rejection that could crash the whole process.
async function getDashboardChatId() {
    try {
        const config = await BotConfig.findById('singleton');
        return config?.dashboardChatId ?? null;
    } catch (err) {
        console.error("Failed to read dashboard chat ID:", err.message);
        return null;
    }
}

async function pushDashboardUpdate(text) {
    try {
        const chatId = await getDashboardChatId();
        if (!chatId) {
            console.log(`Dashboard push skipped (no chat ID known yet): ${text}`);
            return;
        }
        await bot.sendMessage(chatId, text);
        console.log(`Dashboard push sent: ${text}`);
    } catch (err) {
        console.error("Dashboard push failed:", err.message);
    }
}

// Logs an interaction to MongoDB (survives redeploys, unlike the old in-memory version)
async function logInteraction(type, trackId, title, artist) {
    try {
        await HistoryEntry.create({ type, trackId, title, artist });
    } catch (err) {
        console.error("Failed to log interaction:", err.message);
    }
}

// Renders one already-resolved Spotify track as a card with the standard action buttons,
// plus its preview audio clip if Spotify provides one.
function sendTrackCard(chatId, track, title, artist) {
    const opts = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "✅ Add to Liked Songs", callback_data: `add_${track.id}` }],
                [{ text: "▶️ Play Now on Device", callback_data: `play_${track.id}` }],
                [{ text: "⏯ Play / Pause", callback_data: `toggle_${track.id}` }],
                [{ text: "❌ Skip / Dismiss", callback_data: "skip" }]
            ]
        }
    };
    bot.sendMessage(chatId, `🎵 ${title} - ${artist}`, opts);

    if (track.preview_url) {
        bot.sendAudio(chatId, track.preview_url, { title, performer: artist })
            .catch(err => console.error(`Preview send failed for "${title}":`, err.message));
    }
}

// Sends each song as a track card (search → resolve → card + buttons). Songs that can't
// be resolved on Spotify get a visible "not found" line. Used by the free-text research
// flow, where every one of the (up to 5) researched songs is expected to be shown.
// Searches run concurrently (independent of each other) — sequentially, up to 5 songs
// each needing up to 2 Spotify calls added several seconds of avoidable latency; cards are
// still sent in the original research order regardless of which search resolves first.
async function sendTrackCards(chatId, songs, accessToken) {
    const tracks = await Promise.all(
        songs.map(song => searchSpotifyTrack(accessToken, song.title, song.artist).catch(() => null))
    );

    songs.forEach((song, i) => {
        const track = tracks[i];
        if (!track) {
            bot.sendMessage(chatId, `🎵 ${song.title} - ${song.artist} (לא נמצא בספוטיפיי)`);
            return;
        }
        sendTrackCard(chatId, track, song.title, song.artist);
    });
}

// Resolves candidate songs against Spotify concurrently, sending a card for the first
// `limit` matches and silently skipping ones that don't resolve. Used by the
// recommendations flow, which over-fetches candidates (5-6) precisely because some won't
// resolve — the user should just see a clean set of playable results, not misses. The
// candidate pool is always small and bounded, so resolving all of them concurrently is
// simpler and faster overall than a sequential early-exit that stops once `limit` is hit.
async function sendAvailableTrackCards(chatId, songs, accessToken, limit) {
    const tracks = await Promise.all(
        songs.map(song => searchSpotifyTrack(accessToken, song.title, song.artist).catch(() => null))
    );

    let sentCount = 0;
    for (let i = 0; i < songs.length && sentCount < limit; i++) {
        if (!tracks[i]) continue;
        sendTrackCard(chatId, tracks[i], songs[i].title, songs[i].artist);
        sentCount++;
    }
    return sentCount;
}

// Moves the session to the next track and plays it, ending the session once tracks run out.
async function advanceSession(accessToken) {
    currentSession.currentIndex += 1;

    if (currentSession.currentIndex >= currentSession.tracks.length) {
        currentSession = null;
        return `זהו, סיימנו עם הפלייליסט. תיהנה מהנסיעה! 🚗`;
    }

    const nextTrack = currentSession.tracks[currentSession.currentIndex];
    const played = await tryPlayTrack(accessToken, nextTrack.trackId);
    return played
        ? `מנגן את "${nextTrack.title}" של ${nextTrack.artist}.`
        : `לא מצאתי מכשיר ספוטיפיי פעיל להמשך הפלייליסט.`;
}

// Saves the current session track to Liked Songs (playlist-content mutation is 403'd
// by Spotify's Development Mode restrictions), then advances to the next one.
// Caller (processSiriCommand) is responsible for pushing the returned text to Telegram —
// this function doesn't push its own partial update, so a failure partway through (e.g.
// the save succeeds but advancing to the next track fails) still gets exactly one
// notification instead of a silent gap.
async function addCurrentTrackToSession(accessToken) {
    const track = currentSession.tracks[currentSession.currentIndex];
    await saveTrackToLibrary(accessToken, track.trackId);
    console.log(`Saved "${track.title}" to Liked Songs.`);
    await logInteraction('added', track.trackId, track.title, track.artist);
    const advanceMsg = await advanceSession(accessToken);
    return `✅ נוסף "${track.title}"! ${advanceMsg}`;
}

// --- Gemini AI Functions ---
async function parseSiriCommand(voiceCommand) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        const prompt = `You are a smart assistant controlling a car's Spotify player.
        User's voice command: "${voiceCommand}"

        Classify the intent into one of these categories:
        - "play" (user wants to play a specific artist, song, or genre)
        - "pause" (user wants to stop/pause music)
        - "next" (user wants to skip to the next track)
        - "add_to_library" (user wants to save the current song or a specific song)
        - "search_lyrics" (user is reciting lyrics to find a song)
        - "playlist" (user wants to add to or create a playlist)
        - "unknown"

        Return ONLY a valid JSON in this exact format (no markdown):
        {
            "intent": "play|pause|next|add_to_library|search_lyrics|playlist|unknown",
            "search_query": "relevant text to search on Spotify (e.g. artist name, song name, lyrics) if applicable. Otherwise leave empty."
        }`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        let text = response.text().replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(text);
    } catch (e) {
        console.error("Siri AI parsing error:", e);
        return null;
    }
}

// Shared low-level caller: sends a prompt expecting {songs:[{title,artist}]} JSON, with
// retry-on-transient-failure (Gemini overload/rate-limiting/network hiccups/truncated-JSON
// are all common on a "cold" first call and usually resolve on retry).
// Returns { songs: [...] } on success, or { error: "quota" | "unavailable" } on failure.
// "quota" means Gemini's daily/rate quota is exhausted (won't resolve by retrying);
// "unavailable" means a transient failure that retrying didn't recover from.
async function callGeminiForSongs(prompt, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const model = genAI.getGenerativeModel({
                model: "gemini-2.5-flash",
                tools: [{ googleSearch: {} }],
                // 2.5 Flash spends part of this budget on internal "thinking" tokens before
                // writing visible output (observed ~2100+ thinking tokens with search grounding
                // active) — 1024 was too tight and caused MAX_TOKENS truncation mid-JSON
                generationConfig: { maxOutputTokens: 4096 }
            });

            const result = await model.generateContent(prompt);
            const response = await result.response;
            let text = response.text();

            text = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return { songs: JSON.parse(text).songs };
        } catch (error) {
            const isQuotaExhausted = /RESOURCE_EXHAUSTED|quota/i.test(error.message || "");

            if (isQuotaExhausted) {
                console.error("Gemini quota exhausted, not retrying:", error.message);
                return { error: "quota" };
            }

            // Retry only on conditions actually likely to resolve on their own: explicit
            // overload/rate-limit statuses, or no status at all (network blips, truncated-
            // JSON parse failures from SyntaxError, which carry no .status). A genuine
            // client error (400 malformed request, 401/403 auth/safety block) has a status
            // outside this set and fails fast instead of burning the full retry budget on
            // an error that will be identical on every attempt.
            const isTransient = error.status === 503 || error.status === 429 || !error.status;
            if (isTransient && i < retries - 1) {
                console.log(`Gemini call failed (${error.status || 'no status'}: ${error.message || error}). Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2;
                continue;
            }

            console.error("Final error in Gemini song request:", error.message || error);
            return { error: "unavailable" };
        }
    }
    return { error: "unavailable" };
}

async function researchMusic(userInput) {
    // Brain upgrade: Gemini now acts as a music historian and anti-algorithm curator (Home Mode)
    const prompt = `You are an elite music historian, curator, and "anti-algorithm" AI DJ.
    Analyze the user's request: "${userInput}".

    DEEP CURATION RULES (THE "BRAIN"):
    1. If the user asks for associative, historical, or "influenced by" music (e.g., "50s blues that influenced Jimi Hendrix"), DO NOT just search the text. Use your deep knowledge to identify the ACTUAL artists (e.g., Muddy Waters, Bo Diddley) and provide their specific best songs.
    2. Bypass generic commercial algorithms. Curate with depth and taste.
    3. USE GOOGLE SEARCH to verify exact track names and albums.
    4. NEVER invent, hallucinate, guess, or translate song titles.
    5. ONLY return REAL, well-known, and officially released songs that exist on Spotify.
    6. Return the EXACT official track and artist name exactly as released on Spotify, in their original native language and script (e.g., Hebrew for Israeli songs). NEVER add English translations, transliterations, or parenthetical annotations — e.g., write "ממעמקים" and "הפרויקט של עידן רייכל", NOT "Mi'Ma'amakim (Out of the Depths) - The Idan Raichel Project". Spotify's search fails on these embellishments.

    If the request is a general greeting or NOT related to music, return EXACTLY: {"songs": []}

    You MUST return ONLY a valid JSON object.
    The JSON must have a single key 'songs' containing an array of up to 5 objects.
    Each object MUST have exactly two keys: 'title' (the exact song name) and 'artist' (the exact artist name).
    DO NOT ADD ANY OTHER TEXT OR MARKDOWN, JUST THE JSON.`;

    return callGeminiForSongs(prompt);
}

// Suggests new tracks in the same vibe as the user's recently liked tracks. Asks for
// 5-6 candidates (over-fetch) since some won't resolve on Spotify's search — the caller
// resolves them, silently drops failures, and shows only the first 3 that succeed.
async function getRecommendations(likedTracks) {
    const trackList = likedTracks.map(t => `- ${t.title} by ${t.artist}`).join('\n');
    const prompt = `You are an elite music curator. A user has recently liked these tracks:
${trackList}

Suggest 5-6 NEW songs (not already in the list above) that match the same vibe, genre, or artistic lineage.
USE GOOGLE SEARCH to verify exact track and artist names.
NEVER invent, hallucinate, or guess song titles. ONLY suggest REAL, officially released songs that exist on Spotify.
Return the EXACT official track and artist name exactly as released on Spotify, in their original native language and script (e.g., Hebrew for Israeli songs). NEVER add English translations, transliterations, or parenthetical annotations — Spotify's search fails on these embellishments.

You MUST return ONLY a valid JSON object.
The JSON must have a single key 'songs' containing an array of 5-6 objects.
Each object MUST have exactly two keys: 'title' (the exact song name) and 'artist' (the exact artist name).
DO NOT ADD ANY OTHER TEXT OR MARKDOWN, JUST THE JSON.`;

    return callGeminiForSongs(prompt);
}

// --- Scheduled Jobs ---
// Builds and sends the weekly "songs saved this week" recap. Wrapped in its own try/catch
// so a Mongo query failure or Telegram send failure never crashes the cron scheduler or
// the server — worst case, one week's summary silently doesn't arrive and next week's
// run is unaffected.
async function sendWeeklySummary() {
    try {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const entries = await HistoryEntry.find({
            type: 'added',
            createdAt: { $gte: sevenDaysAgo }
        }).sort({ createdAt: -1 });

        if (entries.length === 0) {
            await pushDashboardUpdate('📅 סיכום שבועי: לא נשמרו שירים חדשים השבוע.');
            return;
        }

        const trackList = entries.map((entry, i) => `${i + 1}. ${entry.title} - ${entry.artist}`).join('\n');
        const summary = `📅 סיכום שבועי\n\nהשבוע נשמרו ${entries.length} שירים חדשים ל-Liked Songs:\n\n${trackList}`;

        await pushDashboardUpdate(summary);
        console.log(`Weekly summary sent: ${entries.length} tracks.`);
    } catch (err) {
        console.error("Weekly summary job failed:", err.message);
    }
}

// Every Sunday at 09:00, Israel time (adjust the timezone if deploying for a different
// audience — node-cron defaults to the server's own system timezone otherwise, which on
// Railway would be UTC, not the intended local time).
function scheduleWeeklySummary() {
    cron.schedule('0 9 * * 0', () => {
        sendWeeklySummary().catch(err => console.error("Unexpected weekly summary error:", err.message));
    }, { timezone: 'Asia/Jerusalem' });
    console.log("Weekly summary job scheduled: every Sunday at 09:00 (Asia/Jerusalem).");
}

// --- Telegram Listeners (Home Mode) ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'היי! אני חוקר המוזיקה שלך. מוכן לחפש לפי הקשר, השפעות היסטוריות, או סתם שירים חדשים. מה נשמע היום? 🎧');
});

bot.onText(/^(\/history|היסטוריה)$/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const recent = await HistoryEntry.find({ type: 'added' }).sort({ createdAt: -1 }).limit(15);

        if (recent.length === 0) {
            bot.sendMessage(chatId, 'אין עדיין שירים שנשמרו ב-Liked Songs.');
            return;
        }

        // Awaited so it's guaranteed to land before any track card — unawaited sendMessage
        // calls race against each other and Telegram doesn't preserve delivery order
        await bot.sendMessage(chatId, `📜 השירים האחרונים שנשמרו:`);

        // The query sorts most-recent-first; reverse so the latest save is sent last,
        // landing at the bottom of the chat as the user expects
        const chronological = recent.slice().reverse();
        for (const entry of chronological) {
            const opts = {
                reply_markup: {
                    inline_keyboard: [[
                        { text: '▶️ Play', callback_data: `play_${entry.trackId}` },
                        { text: '❌ Remove from Liked Songs', callback_data: `remove_${entry.trackId}` }
                    ]]
                }
            };
            await bot.sendMessage(chatId, `🎵 ${entry.title} - ${entry.artist}`, opts);
        }

        await bot.sendMessage(chatId, 'רוצה המלצות חדשות בהשראת מה שאהבת?', {
            reply_markup: { inline_keyboard: [[{ text: '💡 Get Recommendations', callback_data: 'get_recommendations' }]] }
        });
    } catch (err) {
        console.error("History fetch error:", err.message);
        bot.sendMessage(chatId, 'הייתה תקלה בשליפת ההיסטוריה. בדוק טרמינל.');
    }
});

bot.onText(/\/debug/, async (msg) => {
    bot.sendMessage(msg.chat.id, 'מריץ דיבאג מול ספוטיפיי... תבדוק את הטרמינל!');
    try {
        const accessToken = await getSpotifyAccessToken();
        const profile = await getSpotifyUserProfile(accessToken);
        if (profile) {
            console.log(`\n================ DEBUG INFO ================`);
            console.log(`Spotify connected as: ${profile.email || 'no email'} (user ID: ${profile.id})`);
            console.log(`Account product: ${profile.product}`);
            console.log(`============================================\n`);
        }
    } catch (e) {
        console.error("Debug error:", e.message);
    }
});

bot.on('message', async (msg) => {
    try {
        if (TELEGRAM_OWNER_CHAT_ID) {
            if (msg.chat.id === TELEGRAM_OWNER_CHAT_ID) {
                await BotConfig.findByIdAndUpdate('singleton', { dashboardChatId: msg.chat.id }, { upsert: true });
            } else {
                console.log(`Ignoring message from non-owner chat ${msg.chat.id} (TELEGRAM_OWNER_CHAT_ID is set).`);
            }
        } else {
            // No explicit owner configured — "claim once": the first chat to ever message
            // the bot becomes the dashboard destination, and a later message from a
            // DIFFERENT chat no longer silently overwrites it (the old, unconditional
            // overwrite let any stranger who messaged the bot hijack all notifications).
            const config = await BotConfig.findById('singleton');
            if (!config?.dashboardChatId || config.dashboardChatId === msg.chat.id) {
                await BotConfig.findByIdAndUpdate('singleton', { dashboardChatId: msg.chat.id }, { upsert: true });
            } else {
                console.log(`Ignoring message from unrecognized chat ${msg.chat.id} (dashboard owner is ${config.dashboardChatId}).`);
            }
        }
    } catch (err) {
        console.error("Failed to check/persist dashboardChatId:", err.message);
    }

    const text = msg.text?.trim();
    if (!text || text === '/start' || text === '/debug' || text === '/history' || text === 'היסטוריה') return;

    const greetings = ['היי', 'הי', 'שלום', 'מה קורה', 'אהלן', 'בוקר טוב', 'ערב טוב', 'hey', 'hi'];
    if (greetings.includes(text.toLowerCase())) {
        bot.sendMessage(msg.chat.id, 'היי! 👋 איזה סגנון או השפעה מוזיקלית בא לך לחקור היום?');
        return;
    }

    bot.sendMessage(msg.chat.id, `מחפש: "${text}"... 🧠`);
    console.log(`\nReceived new deep research request: "${text}"`);
    const result = await researchMusic(text);

    if (result.songs && result.songs.length > 0) {
        console.log("AI finished deep research! Sending buttons...");
        const accessToken = await getSpotifyAccessToken().catch(err => {
            console.error("Spotify auth failed while sending song cards:", err.message);
            return null;
        });

        if (accessToken) {
            await sendTrackCards(msg.chat.id, result.songs, accessToken);
        } else {
            bot.sendMessage(msg.chat.id, `הייתה תקלה בהתחברות לספוטיפיי. בדוק טרמינל.`);
        }
    } else if (result.songs && result.songs.length === 0) {
        bot.sendMessage(msg.chat.id, `נראה שלא ביקשת מוזיקה. נסה לתת לי כיוון כמו "בלוז שהשפיע על הנדריקס".`);
    } else if (result.error === "quota") {
        bot.sendMessage(msg.chat.id, `נגמרה המכסה היומית של Gemini. אפשר לנסות שוב מאוחר יותר.`);
    } else {
        bot.sendMessage(msg.chat.id, `השרתים עמוסים כרגע. בוא ננסה שוב בעוד כמה שניות.`);
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('add_')) {
        const trackId = data.slice('add_'.length);
        bot.answerCallbackQuery(query.id, { text: 'שומר ל-Liked Songs...' });

        try {
            const accessToken = await getSpotifyAccessToken();
            const info = await getTrackInfo(accessToken, trackId);
            const artistNames = info.artists.map(a => a.name).join(', ');
            await saveTrackToLibrary(accessToken, trackId);
            await logInteraction('added', trackId, info.name, artistNames);
            console.log(`Successfully injected "${info.name}" to Spotify library!`);
            bot.sendMessage(chatId, `✅ השיר "${info.name}" נוסף ל-Liked Songs שלך! 🎵`);
        } catch (error) {
            console.error(`Spotify API error:`, error.response?.data || error.message);
            bot.sendMessage(chatId, `❌ הייתה תקלה בהוספת השיר לספוטיפיי. בדוק טרמינל.`);
        }

        bot.deleteMessage(chatId, messageId).catch(() => {});

    } else if (data.startsWith('play_')) {
        const trackId = data.slice('play_'.length);
        bot.answerCallbackQuery(query.id, { text: 'מנגן במכשיר...' });

        try {
            const accessToken = await getSpotifyAccessToken();
            const info = await getTrackInfo(accessToken, trackId);
            const artistNames = info.artists.map(a => a.name).join(', ');
            const device = await tryPlayTrack(accessToken, trackId);
            if (device) {
                await logInteraction('played', trackId, info.name, artistNames);
                bot.sendMessage(chatId, `▶️ מנגן את "${info.name}" על ${device.name}.`);
            } else {
                bot.sendMessage(chatId, `❌ לא מצאתי מכשיר ספוטיפיי פעיל. תפתח את ספוטיפיי ונסה שוב.`);
            }
        } catch (error) {
            console.error(`Spotify API error:`, error.response?.data || error.message);
            bot.sendMessage(chatId, `❌ הייתה תקלה בניגון השיר. בדוק טרמינל.`);
        }

    } else if (data.startsWith('toggle_')) {
        // Note: the button's own trackId isn't used here — toggle acts on whatever is
        // globally playing/paused on the device, which may not be this card's track at
        // all (there's no per-track pause in Spotify's API), so history is logged against
        // whatever's actually playing (below), not the button that was pressed.
        bot.answerCallbackQuery(query.id, { text: 'מחליף מצב נגינה...' });

        try {
            const accessToken = await getSpotifyAccessToken();
            const { device, isPlaying } = await getPlaybackState(accessToken);
            if (!device) {
                bot.sendMessage(chatId, `❌ לא מצאתי מכשיר ספוטיפיי פעיל.`);
            } else {
                if (isPlaying) {
                    await pausePlaybackOnDevice(accessToken, device.id);
                    bot.sendMessage(chatId, `⏸ עצרתי את המוזיקה.`);
                } else {
                    await resumePlaybackOnDevice(accessToken, device.id);
                    bot.sendMessage(chatId, `▶️ ממשיך לנגן.`);
                }
                const nowPlaying = await getCurrentlyPlayingTrack(accessToken);
                if (nowPlaying) {
                    const artistNames = nowPlaying.artists.map(a => a.name).join(', ');
                    await logInteraction('toggled', nowPlaying.id, nowPlaying.name, artistNames);
                }
            }
        } catch (error) {
            console.error(`Spotify API error:`, error.response?.data || error.message);
            bot.sendMessage(chatId, `❌ הייתה תקלה בשליטה על הנגן. בדוק טרמינל.`);
        }

    } else if (data.startsWith('remove_')) {
        const trackId = data.slice('remove_'.length);
        bot.answerCallbackQuery(query.id, { text: 'מסיר מ-Liked Songs...' });

        try {
            const accessToken = await getSpotifyAccessToken();
            await removeTrackFromLibrary(accessToken, trackId);
            await HistoryEntry.deleteMany({ type: 'added', trackId });
            bot.sendMessage(chatId, `❌ השיר הוסר מ-Liked Songs.`);
            bot.deleteMessage(chatId, messageId).catch(() => {});
        } catch (error) {
            console.error(`Spotify API error:`, error.response?.data || error.message);
            bot.sendMessage(chatId, `❌ הייתה תקלה בהסרת השיר. בדוק טרמינל.`);
        }

    } else if (data === 'get_recommendations') {
        bot.answerCallbackQuery(query.id, { text: 'מחפש המלצות...' });

        try {
            const recent = await HistoryEntry.find({ type: 'added' }).sort({ createdAt: -1 }).limit(10);
            if (recent.length === 0) {
                bot.sendMessage(chatId, 'עדיין אין לך היסטוריית שירים שמורים - תוסיף כמה שירים קודם! 🎵');
                return;
            }

            const result = await getRecommendations(recent.map(r => ({ title: r.title, artist: r.artist })));
            if (result.songs && result.songs.length > 0) {
                const accessToken = await getSpotifyAccessToken();
                const sentCount = await sendAvailableTrackCards(chatId, result.songs, accessToken, 3);
                if (sentCount === 0) {
                    bot.sendMessage(chatId, 'לא הצלחתי למצוא המלצות זמינות בספוטיפיי כרגע.');
                }
            } else {
                bot.sendMessage(chatId, 'לא הצלחתי למצוא המלצות כרגע. נסה שוב מאוחר יותר.');
            }
        } catch (error) {
            console.error(`Recommendation flow error:`, error.response?.data || error.message);
            bot.sendMessage(chatId, 'הייתה תקלה בהבאת המלצות. בדוק טרמינל.');
        }

    } else if (data === 'skip') {
        console.log("User skipped a song.");
        bot.answerCallbackQuery(query.id, { text: "דילגנו." });
        bot.deleteMessage(chatId, messageId).catch(() => {});
    }
});

// --- Server & Spotify OAuth ---
app.get('/', (req, res) => {
    res.send("Music Server is LIVE!");
});

// Serializes background Siri processing so overlapping requests can never interleave —
// processSiriCommand reads/writes the shared `currentSession` state across several await
// points, and two concurrent invocations (e.g. a quick "next" followed by a new "playlist"
// request) could otherwise race and corrupt or misapply the session. Chaining onto a single
// promise guarantees each call fully finishes before the next one starts, without needing a
// mutex library — this is a low-traffic personal bot, so a request queue costs nothing.
let siriProcessingQueue = Promise.resolve();

app.post('/api/siri', (req, res) => {
    const voiceCommand = req.body.command || req.body.text;

    if (!voiceCommand) {
        return res.status(400).send({ status: "error", message: "לא סופקה פקודה." });
    }

    // Respond immediately — Siri's own voice-interaction patience window is shorter than
    // Gemini research + Spotify round-trips can reliably take (confirmed: broad queries
    // like "80s jazz" made Siri show "Something went wrong" even though the song played
    // moments later). The real outcome now arrives via the Telegram dashboard push instead
    // of the HTTP response, since there's no live request left to send it back on.
    res.status(200).send({ status: "success", message: "מטפל בבקשה, תעדכן אותך בטלגרם." });

    siriProcessingQueue = siriProcessingQueue
        .then(() => processSiriCommand(voiceCommand))
        .catch(err => console.error("Background Siri processing failed:", err.message));
});

async function processSiriCommand(voiceCommand) {
    console.log(`\nSiri voice command received: "${voiceCommand}"`);

    // 1. Send to Gemini to classify the intent of the sentence
    const parsed = await parseSiriCommand(voiceCommand);

    if (!parsed) {
        await pushDashboardUpdate(`🎙️ Siri: לא הצלחתי להבין את הפקודה "${voiceCommand}".`);
        return;
    }

    console.log(`Siri intent: [${parsed.intent}] | Query: [${parsed.search_query}]`);

    // 1b. Interactive playlist session: while a session is active, "add" (add_to_library)
    //     and "skip" (next) act on the current session track instead of a fresh lookup
    if (currentSession && (parsed.intent === "add_to_library" || parsed.intent === "next")) {
        let sessionReply;
        try {
            const accessToken = await getSpotifyAccessToken();
            sessionReply = parsed.intent === "add_to_library"
                ? await addCurrentTrackToSession(accessToken)
                : await advanceSession(accessToken);
        } catch (error) {
            console.error("Playlist session error:", error.response?.data || error.message);
            sessionReply = `הייתה תקלה בהמשך הפלייליסט. בדוק טרמינל.`;
        }
        // Always push exactly once here (addCurrentTrackToSession no longer pushes its own
        // partial update) so a failure partway through — e.g. the save succeeds but the
        // internal advance-to-next-track fails — still reaches the user instead of going
        // silent because the "add" branch used to rely on an internal push that never ran
        await pushDashboardUpdate(`🎙️ Siri: ${sessionReply}`);
        return;
    }

    // 2. For intents about a specific song, run the same deep-curation lookup
    //    used by the Telegram flow so replies reference a real, verified track
    const needsLookup = ["play", "add_to_library", "search_lyrics"].includes(parsed.intent);
    let match = null;

    if (needsLookup && parsed.search_query) {
        const result = await researchMusic(parsed.search_query);
        if (result.songs && result.songs.length > 0) {
            match = result.songs[0];
        }
    }

    // 3. Actually drive Spotify playback for player-control intents
    let replyText = "";
    // Tracks whether this intent already pushed its own specific Telegram feedback (e.g.
    // a track card), so the generic fallback below only fires when nothing was sent yet —
    // replacing a static "these 3 intents always notify themselves" assumption, which was
    // wrong: their own FAILURE branches (no match, track not on Spotify, no device, no
    // research results) never pushed anything and went completely silent.
    let notified = false;
    try {
        switch (parsed.intent) {
            case "play": {
                if (!match) {
                    replyText = `לא הצלחתי לאתר שיר תואם ל-${parsed.search_query}.`;
                    break;
                }
                const accessToken = await getSpotifyAccessToken();
                const track = await searchSpotifyTrack(accessToken, match.title, match.artist);
                if (!track) {
                    replyText = `מצאתי את "${match.title}" של ${match.artist}, אבל הוא לא זמין בספוטיפיי.`;
                    break;
                }
                const played = await tryPlayTrack(accessToken, track.id);
                if (played) {
                    if (currentSession) {
                        // A direct "play" while a driving session is active means the
                        // session's bookkeeping no longer matches what's actually playing —
                        // end it rather than let a later "add"/"skip" act on a stale track.
                        console.log("Ending driving session: a direct play command changed what's playing.");
                        currentSession = null;
                    }
                    await logInteraction('played', track.id, match.title, match.artist);
                    const chatId = await getDashboardChatId();
                    if (chatId) {
                        sendTrackCard(chatId, track, match.title, match.artist);
                        notified = true;
                    }
                }
                replyText = played
                    ? `מפעיל עכשיו את "${match.title}" של ${match.artist}.`
                    : `לא מצאתי מכשיר ספוטיפיי פעיל. תפתח את ספוטיפיי במכשיר ונסה שוב.`;
                break;
            }
            case "pause": {
                const accessToken = await getSpotifyAccessToken();
                const device = await getActiveDevice(accessToken);
                if (!device) {
                    replyText = `לא מצאתי מכשיר ספוטיפיי פעיל.`;
                    break;
                }
                await pausePlaybackOnDevice(accessToken, device.id);
                replyText = `עוצר את המוזיקה.`;
                break;
            }
            case "next": {
                const accessToken = await getSpotifyAccessToken();
                const device = await getActiveDevice(accessToken);
                if (!device) {
                    replyText = `לא מצאתי מכשיר ספוטיפיי פעיל.`;
                    break;
                }
                await skipToNextOnDevice(accessToken, device.id);
                replyText = `מעביר לשיר הבא.`;
                break;
            }
            case "add_to_library": {
                if (!match) {
                    replyText = `לא הצלחתי לאתר שיר תואם ל-${parsed.search_query}.`;
                    break;
                }
                const accessToken = await getSpotifyAccessToken();
                const track = await searchSpotifyTrack(accessToken, match.title, match.artist);
                if (!track) {
                    replyText = `מצאתי את "${match.title}" של ${match.artist}, אבל הוא לא זמין בספוטיפיי.`;
                    break;
                }
                await saveTrackToLibrary(accessToken, track.id);
                await logInteraction('added', track.id, match.title, match.artist);
                await pushDashboardUpdate(`✅ נוסף ל-Liked Songs (Siri): ${match.title} - ${match.artist}`);
                notified = true;
                replyText = `שמרתי את "${match.title}" של ${match.artist} לספרייה.`;
                break;
            }
            case "search_lyrics":
                replyText = match
                    ? `מצאתי: "${match.title}" של ${match.artist}.`
                    : `לא הצלחתי למצוא שיר לפי המילים: ${parsed.search_query}.`;
                break;
            case "playlist": {
                const accessToken = await getSpotifyAccessToken();
                const research = await researchMusic(parsed.search_query);
                if (!research.songs || research.songs.length === 0) {
                    replyText = `לא הצלחתי למצוא שירים מתאימים לפלייליסט "${parsed.search_query}".`;
                    break;
                }

                // Resolve all candidates concurrently — this is on the critical path before
                // any audio starts in a voice-triggered driving session, and sequentially
                // resolving 5-6 songs (each up to 2 Spotify calls) added real, noticeable
                // silence before playback began. Promise.all preserves order, so tracks[0]
                // still corresponds to research.songs[0] regardless of resolution order.
                const resolved = await Promise.all(
                    research.songs.map(song => searchSpotifyTrack(accessToken, song.title, song.artist).catch(() => null))
                );
                const tracks = research.songs
                    .map((song, i) => resolved[i] && { trackId: resolved[i].id, title: song.title, artist: song.artist })
                    .filter(Boolean);

                if (tracks.length === 0) {
                    replyText = `לא מצאתי אף שיר זמין בספוטיפיי לבקשה הזו.`;
                    break;
                }

                currentSession = { tracks, currentIndex: 0 };
                console.log(`Driving session started: ${tracks.length} tracks`);
                await pushDashboardUpdate(`🚗 סשן פלייליסט התחיל: "${parsed.search_query}" (${tracks.length} שירים)`);
                notified = true;

                const device = await tryPlayTrack(accessToken, tracks[0].trackId);
                if (device) {
                    // Queue the rest so drive-time playback continues naturally even if
                    // the user never says "add"/"skip" for the remaining tracks
                    for (const track of tracks.slice(1)) {
                        try {
                            await queueTrackOnDevice(accessToken, track.trackId, device.id);
                        } catch (err) {
                            console.error(`Failed to queue "${track.title}":`, err.response?.data || err.message);
                        }
                    }
                }
                replyText = device
                    ? `יצרתי פלייליסט ומתחיל לנגן את "${tracks[0].title}" של ${tracks[0].artist}. תגיד "הוסף" או "דלג" בזמן הנסיעה.`
                    : `יצרתי את הפלייליסט אבל לא מצאתי מכשיר ספוטיפיי פעיל.`;
                break;
            }
            default:
                replyText = `שמעתי אותך, אבל עדיין לא למדתי איך לעשות את זה.`;
        }
    } catch (error) {
        console.error("Spotify playback control error:", error.response?.data || error.message);
        replyText = `הייתה תקלה בשליטה על ספוטיפיי. בדוק טרמינל.`;
    }

    // Note: search_lyrics is identification-only by design (there's no Spotify action
    // to take beyond naming the matched track), so it just returns the spoken match

    // Fires for every case that didn't already push its own specific feedback — covers
    // pause/next/search_lyrics/unknown, AND every failure branch of play/add_to_library/
    // playlist (no match, track not on Spotify, no device, no research results), which
    // previously went completely silent under the old static intent-name check
    if (!notified) {
        await pushDashboardUpdate(`🎙️ Siri: ${replyText}`);
    }
}

// "Save what's playing right now" — no Gemini/NLU needed, so this is its own fast route
// rather than an /api/siri intent. Immediate-response pattern kept for consistency with
// /api/siri even though this path is inherently quick, so a slow Spotify response can
// never cause a Shortcut timeout here either.
app.post('/api/save-current', (req, res) => {
    res.status(200).send({ status: "success", message: "בודק מה מתנגן ושומר..." });
    saveCurrentlyPlayingTrack().catch(err => {
        console.error("Background save-current-track processing failed:", err.message);
    });
});

async function saveCurrentlyPlayingTrack() {
    try {
        const accessToken = await getSpotifyAccessToken();
        const track = await getCurrentlyPlayingTrack(accessToken);

        if (!track) {
            // Covers both "nothing playing" (204) and "it's a podcast episode/ad, not a
            // track" (currently_playing_type !== 'track') — getCurrentlyPlayingTrack
            // returns null for either, so this message is deliberately worded to fit both
            console.log("Nothing savable currently playing (either idle or non-track content).");
            pushDashboardUpdate("🎧 אין שיר לשמור כרגע (אולי שום דבר לא מתנגן, או שזה פודקאסט ולא שיר).");
            return;
        }

        const artistNames = track.artists.map(a => a.name).join(', ');
        await saveTrackToLibrary(accessToken, track.id);
        await logInteraction('added', track.id, track.name, artistNames);
        console.log(`Saved currently playing track "${track.name}" to Liked Songs.`);
        pushDashboardUpdate(`✅ נשמר ל-Liked Songs: ${track.name} - ${artistNames}`);
    } catch (error) {
        console.error("Save-current-track error:", error.response?.data || error.message);
        pushDashboardUpdate("❌ הייתה תקלה בשמירת השיר הנוכחי. בדוק טרמינל.");
    }
}

app.get('/login', (req, res) => {
    const scope = 'user-read-private user-read-email playlist-modify-public playlist-modify-private user-library-modify user-library-read user-modify-playback-state user-read-playback-state';

    res.redirect('https://accounts.spotify.com/authorize?' +
        querystring.stringify({
            response_type: 'code',
            client_id: SPOTIFY_CLIENT_ID,
            scope: scope,
            redirect_uri: SPOTIFY_REDIRECT_URI,
            show_dialog: true
        }));
});

app.get('/callback', async (req, res) => {
    const authCode = req.query.code;
    if (authCode) {
         try {
             const response = await axios({
                 method: 'post',
                 url: 'https://accounts.spotify.com/api/token',
                 data: querystring.stringify({
                     grant_type: 'authorization_code',
                     code: authCode,
                     redirect_uri: SPOTIFY_REDIRECT_URI
                 }),
                 headers: {
                     'content-type': 'application/x-www-form-urlencoded',
                     'Authorization': `Basic ${Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')}`
                 }
             });
             console.log("REFRESH_TOKEN:", response.data.refresh_token);
             res.send(`Success! Please copy the NEW refresh token from the terminal.`);
         } catch (error) {
             console.error("Callback token exchange failed:", error.response?.data || error.message);
             res.send("Error fetching tokens. Check terminal logs.");
         }
    }
});

// MongoDB is load-bearing on Railway (ephemeral filesystem), so the app must not accept
// any Telegram or HTTP traffic until it's confirmed connected — fail loudly otherwise.
async function start() {
    try {
        await mongoose.connect(MONGO_URI);
        console.log("Connected to MongoDB");
    } catch (err) {
        console.error("FATAL: MongoDB connection failed:", err.message);
        process.exit(1);
    }

    // Just ensures the singleton doc exists; the value itself is always re-read fresh
    // from Mongo on demand (see getDashboardChatId), never cached in-memory.
    const config = await BotConfig.findByIdAndUpdate(
        'singleton',
        {},
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    console.log(`Dashboard chat ID in DB: ${config.dashboardChatId ?? '(none yet)'}`);

    scheduleWeeklySummary();

    bot.startPolling();
    app.listen(PORT, () => {
        console.log(`Server listening on http://127.0.0.1:${PORT}`);
        console.log(`System ready for Telegram and Siri!`);
    });
}

start();
