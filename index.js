require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const express = require('express');
const querystring = require('querystring');
const axios = require('axios'); 

// Setup from .env
const token = process.env.TELEGRAM_TOKEN;
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET; 
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI;
const SPOTIFY_REFRESH_TOKEN = process.env.SPOTIFY_REFRESH_TOKEN; 

const bot = new TelegramBot(token, { polling: true });
const app = express();
app.use(express.json()); // חובה כדי שנוכל לקבל פקודות מסירי באייפון (JSON)
const PORT = 8888;

console.log("🤖 Music bot is on air");

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

// כלי ריגול לבדיקת המשתמש המחובר
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

async function searchSpotifyTrack(accessToken, title, artist) {
    // שלב 1: חיפוש רחב לטקסט חופשי 
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
                return track.id; 
            }
        }
    }
    
    // שלב 2: תגיות מפורשות למספרים וכו'
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
            if (artistMatch) return track.id;
        }
        return strictResponse.data.tracks.items[0].id; 
    }
    
    return null; 
}

// הפונקציה שעובדת מעולה להזרקה לספרייה
async function saveTrackToLibrary(accessToken, trackId) {
    // ספוטיפיי החליפו את /me/tracks ב- /me/library ודורשים שימוש ב-uri ייעודי
    await axios({
        method: 'put',
        url: `https://api.spotify.com/v1/me/library?uris=spotify:track:${trackId}`,
        headers: { 
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
        }
    });
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
        console.error("❌ Siri AI parsing error:", e);
        return null;
    }
}

async function researchMusic(userInput, retries = 3, delay = 2000) {
    for (let i = 0; i < retries; i++) {
        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                tools: [{ googleSearch: {} }] 
            });
            
            // שדרוג המוח: מעכשיו ג'מיני מתנהג כהיסטוריון מוזיקה ואנטי-אלגוריתם (ערוץ הבית)
            const prompt = `You are an elite music historian, curator, and "anti-algorithm" AI DJ.
            Analyze the user's request: "${userInput}".
            
            DEEP CURATION RULES (THE "BRAIN"):
            1. If the user asks for associative, historical, or "influenced by" music (e.g., "50s blues that influenced Jimi Hendrix"), DO NOT just search the text. Use your deep knowledge to identify the ACTUAL artists (e.g., Muddy Waters, Bo Diddley) and provide their specific best songs.
            2. Bypass generic commercial algorithms. Curate with depth and taste.
            3. USE GOOGLE SEARCH to verify exact track names and albums.
            4. NEVER invent, hallucinate, guess, or translate song titles.
            5. ONLY return REAL, well-known, and officially released songs that exist on Spotify.
            6. For Israeli music, use the exact original Hebrew title.

            If the request is a general greeting or NOT related to music, return EXACTLY: {"songs": []}

            You MUST return ONLY a valid JSON object.
            The JSON must have a single key 'songs' containing an array of up to 5 objects.
            Each object MUST have exactly two keys: 'title' (the exact song name) and 'artist' (the exact artist name).
            DO NOT ADD ANY OTHER TEXT OR MARKDOWN, JUST THE JSON.`;

            const result = await model.generateContent(prompt);
            const response = await result.response;
            let text = response.text();
            
            text = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(text).songs;
        } catch (error) {
            if ((error.status === 503 || error.status === 429) && i < retries - 1) {
                console.log(`⚠️ Google server overloaded (Status ${error.status}). Retrying in ${delay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                delay *= 2; 
                continue;
            }
            console.error("❌ Final error in research:", error);
            return null;
        }
    }
    return null;
}

// --- Telegram Listeners (Home Mode / ערוץ הבית) ---
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'היי! אני חוקר המוזיקה שלך. מוכן לחפש לפי הקשר, השפעות היסטוריות, או סתם שירים חדשים. מה נשמע היום? 🎧');
});

bot.onText(/\/debug/, async (msg) => {
    bot.sendMessage(msg.chat.id, 'מריץ דיבאג מול ספוטיפיי... תבדוק את הטרמינל!');
    try {
        const accessToken = await getSpotifyAccessToken();
        const profile = await getSpotifyUserProfile(accessToken);
        if (profile) {
            console.log(`\n================ DEBUG INFO ================`);
            console.log(`👤 Spotify Connected As: ${profile.email || 'No Email'} (User ID: ${profile.id})`);
            console.log(`🔒 Account Product: ${profile.product}`);
            console.log(`============================================\n`);
        }
    } catch (e) {
        console.error("Debug Error:", e.message);
    }
});

bot.on('message', async (msg) => {
    const text = msg.text.trim();
    if (text === '/start' || text === '/debug') return;

    const greetings = ['היי', 'הי', 'שלום', 'מה קורה', 'אהלן', 'בוקר טוב', 'ערב טוב', 'hey', 'hi'];
    if (greetings.includes(text.toLowerCase())) {
        bot.sendMessage(msg.chat.id, 'היי! 👋 איזה סגנון או השפעה מוזיקלית בא לך לחקור היום?');
        return; 
    }

    bot.sendMessage(msg.chat.id, `מחפש: "${text}"... 🧠`);
    console.log(`\n🔍 Received new deep research request: "${text}"`);
    const songs = await researchMusic(text);

    if (songs && songs.length > 0) {
        console.log("✅ AI finished deep research! Sending buttons...");
        songs.forEach(song => {
            const opts = {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: "✅ הוסף", callback_data: `add_${song.title}|${song.artist}` },
                            { text: "❌ דלג", callback_data: "skip" }
                        ]
                    ]
                }
            };
            bot.sendMessage(msg.chat.id, `🎵 ${song.title} - ${song.artist}`, opts);
        });
    } else if (songs && songs.length === 0) {
        bot.sendMessage(msg.chat.id, `נראה שלא ביקשת מוזיקה. נסה לתת לי כיוון כמו "בלוז שהשפיע על הנדריקס".`);
    } else {
        bot.sendMessage(msg.chat.id, `השרתים עמוסים כרגע. בוא ננסה שוב בעוד כמה שניות.`);
    }
});

bot.on('callback_query', async (query) => {
    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    if (data.startsWith('add_')) {
        const songDetails = data.split('add_')[1];
        const title = songDetails.split('|')[0];
        const artist = songDetails.split('|')[1];

        bot.answerCallbackQuery(query.id, { text: `מזריק את ${title} לספוטיפיי...` });

        try {
            const accessToken = await getSpotifyAccessToken();
            const trackId = await searchSpotifyTrack(accessToken, title, artist);
            
            if (trackId) {
                await saveTrackToLibrary(accessToken, trackId);
                console.log(`✅ Successfully injected "${title}" to Spotify Library!`);
                bot.sendMessage(chatId, `✅ השיר ${title} מנגן עכשיו בספריית ה-Spotify שלך! 🎵`);
            } else {
                console.log(`❌ Track not found on Spotify: "${title} - ${artist}"`);
                bot.sendMessage(chatId, `❌ לא הצלחתי למצוא את השיר ${title} במאגר של ספוטיפיי.`);
            }
        } catch (error) {
            console.error(`❌ Spotify API Error:`, error.message);
            bot.sendMessage(chatId, `❌ הייתה תקלה בהוספת השיר לספוטיפיי. בדוק טרמינל.`);
        }

        bot.deleteMessage(chatId, messageId).catch(() => {});

    } else if (data === 'skip') {
        console.log("⏭️ User skipped a song.");
        bot.answerCallbackQuery(query.id, { text: "דילגנו." });
        bot.deleteMessage(chatId, messageId).catch(() => {});
    }
});

// --- Server & Spotify OAuth ---
app.get('/', (req, res) => {
    res.send("🤖 Music Server is LIVE!");
});

app.post('/api/siri', async (req, res) => {
    const voiceCommand = req.body.command;
    console.log(`\n🎙️ SIRI VOICE COMMAND RECEIVED: "${voiceCommand}"`);
    
    if (!voiceCommand) {
        return res.status(400).send({ status: "error", message: "No command provided" });
    }

    // 1. שולחים לג'מיני שינתח את הכוונה מהמשפט
    const parsed = await parseSiriCommand(voiceCommand);
    
    if (!parsed) {
         return res.send({ status: "error", message: "לא הצלחתי להבין את הפקודה." });
    }

    console.log(`🧠 Siri Intent: [${parsed.intent}] | Query: [${parsed.search_query}]`);

    // 2. מכינים תשובה קולית שסירי תקריא לך ברכב
    let replyText = "";
    switch (parsed.intent) {
        case "play": replyText = `מפעיל עכשיו את ${parsed.search_query} בספוטיפיי.`; break;
        case "pause": replyText = `עוצר את המוזיקה.`; break;
        case "next": replyText = `מעביר לשיר הבא.`; break;
        case "add_to_library": replyText = `שומר את השיר לספרייה.`; break;
        case "search_lyrics": replyText = `מחפש שיר לפי המילים: ${parsed.search_query}.`; break;
        case "playlist": replyText = `מטפל בפלייליסט עבור ${parsed.search_query}.`; break;
        default: replyText = `שמעתי אותך, אבל עדיין לא למדתי איך לעשות את זה.`;
    }

    // כאן בצעד הבא נכניס את הפקודות שממש שולטות בספוטיפיי
    
    res.send({ status: "success", message: replyText, intent: parsed.intent });
});

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
             res.send(`✅ Success! Please copy the NEW Refresh Token from the terminal.`);
         } catch (error) {
             res.send("❌ Error fetching tokens. Check terminal logs.");
         }
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server listening on http://127.0.0.1:${PORT}`);
    console.log(`✅ System ready for Telegram and Siri!`);
});