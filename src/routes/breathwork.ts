import { Router, Response } from "express";
import { pool } from "../db";
import OpenAI from "openai";
import fs from "fs";
import path from "path";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// Cache for generated TTS audio (day -> buffer)
const ttsCache = new Map<string, Buffer>();

const router = Router();

const BREATHWORK_TYPES = [
  {
    name: "Box Breathing",
    description: "Inhale for 4 counts, hold for 4 counts, exhale for 4 counts, hold for 4 counts. Repeat 5 times.",
    script: "Welcome... to today's guided box breathing exercise. Box breathing helps calm your nervous system... and improve focus. Let's begin. First, find a comfortable position... and close your eyes if you'd like. Take a moment to settle in... Now, we'll start with a normal breath. Then, inhale slowly through your nose. One... Two... Three... Four... Hold that breath. One... Two... Three... Four... Now exhale slowly through your mouth. One... Two... Three... Four... Hold, empty. One... Two... Three... Four... Good. Let's continue. Inhale. One... Two... Three... Four... Hold. One... Two... Three... Four... Exhale. One... Two... Three... Four... Hold. One... Two... Three... Four... Continue at your own pace with this rhythm. Inhale. One... Two... Three... Four... Hold. One... Two... Three... Four... Exhale. One... Two... Three... Four... Hold. One... Two... Three... Four... Beautiful. Keep breathing this way... Each breath bringing you deeper into calm. When you're ready... take three natural breaths... and gently open your eyes. You've completed your box breathing exercise.",
  },
  {
    name: "Diaphragmatic Breathing",
    description: "Deep belly breathing to activate your parasympathetic nervous system. Breathe in for 4 counts, out for 6 counts.",
    script: "Welcome... to diaphragmatic breathing. This technique helps reduce stress... and promotes deep relaxation. Find a comfortable seated or lying position. You can place one hand on your chest... and one on your belly. Let's begin. Breathe normally for a moment... Now, as you inhale through your nose, imagine the breath traveling all the way down into your belly, causing it to expand. One... Two... Three... Four... Pause briefly... Now exhale slowly through your mouth, longer this time. One... Two... Three... Four... Five... Six... Feel your belly fall as you release the breath. Again, inhale through your nose. One... Two... Three... Four... And exhale. One... Two... Three... Four... Five... Six... The exhale is longer than the inhale, which signals your body to relax. Continue this pattern. Inhale. One... Two... Three... Four... Exhale. One... Two... Three... Four... Five... Six... Feel yourself becoming more and more relaxed with each breath. Inhale deeply. One... Two... Three... Four... Exhale slowly. One... Two... Three... Four... Five... Six... You're doing beautifully. Continue breathing this way, allowing your body to sink deeper into calm with each cycle. When you're ready, take a few natural breaths... and gently return to your day.",
  },
  {
    name: "4-7-8 Breathing",
    description: "A calming technique: inhale for 4, hold for 7, exhale for 8. Perfect before sleep.",
    script: "Welcome... to the 4-7-8 breathing technique, designed to calm your mind... and prepare your body for rest. Find a comfortable position, seated or lying down. Let's begin. Start by exhaling completely through your mouth, slow and soft... Now, close your mouth and inhale quietly through your nose. One... Two... Three... Four... Hold that breath. One... Two... Three... Four... Five... Six... Seven... Now exhale completely through your mouth. One... Two... Three... Four... Five... Six... Seven... Eight... This completes one cycle. Let's do it again. Inhale through your nose. One... Two... Three... Four... Hold. One... Two... Three... Four... Five... Six... Seven... Exhale. One... Two... Three... Four... Five... Six... Seven... Eight... Wonderful. Continue with this rhythm. Inhale. One... Two... Three... Four... Hold. One... Two... Three... Four... Five... Six... Seven... Exhale. One... Two... Three... Four... Five... Six... Seven... Eight... Feel the calm washing over you. Continue several more times at your own pace. This technique is wonderful before bedtime. When you're complete, take normal breaths... and allow yourself to rest peacefully.",
  },
  {
    name: "Alternate Nostril Breathing",
    description: "Balance your energy: alternate between breathing through left and right nostrils.",
    script: "Welcome... to alternate nostril breathing, a balancing technique that harmonizes your body... and mind. Sit comfortably with your spine straight. We'll use a hand position called Vishnu mudra. Fold your index and middle fingers down, leaving your thumb and ring finger extended. Let's begin. Close your right nostril with your thumb... and inhale through your left nostril. One... Two... Three... Four... Now release your thumb... and close your left nostril with your ring finger. Exhale through your right nostril. One... Two... Three... Four... Inhale through the right nostril. One... Two... Three... Four... Switch again. Close your right nostril... and exhale through the left. One... Two... Three... Four... This is one complete cycle. Continue, slowly... Inhale left. One... Two... Three... Four... Switch, exhale right. One... Two... Three... Four... Inhale right. One... Two... Three... Four... Switch, exhale left. One... Two... Three... Four... Wonderful. You're balancing your energy with each breath. Keep this rhythm flowing smoothly... Feel yourself becoming more centered and calm. When you're ready, return to normal breathing with both nostrils. You've completed your alternate nostril breathing.",
  },
  {
    name: "Coherent Breathing",
    description: "5-second inhale, 5-second exhale. Synchronizes heart rate variability.",
    script: "Welcome... to coherent breathing, a gentle technique that brings your body into a state of balance... and ease. Find a comfortable position. Let's begin with a few normal breaths to settle in... Now, we'll inhale through your nose. One... Two... Three... Four... Five... Then exhale through your mouth. One... Two... Three... Four... Five... The breath is equal in and out, creating a beautiful rhythm. Inhale. One... Two... Three... Four... Five... Exhale. One... Two... Three... Four... Five... This simple pattern has profound effects on your nervous system. Inhale. One... Two... Three... Four... Five... Exhale. One... Two... Three... Four... Five... Continue at this peaceful pace... Each breath bringing you more into the present moment. Inhale. One... Two... Three... Four... Five... Exhale. One... Two... Three... Four... Five... Feel your heart rate synchronizing with your breath. You're in perfect coherence. Continue this rhythm for as long as you'd like. This is your anchor, your place of calm. When you're ready, let your breath return to normal... and rest in this peaceful state.",
  },
  {
    name: "Lion's Breath",
    description: "Energizing exhale with open mouth and tongue out. Great for releasing tension.",
    script: "Welcome... to Lion's Breath, a gentle yet invigorating technique that helps release tension. Find a comfortable seated position... Let's begin. Take a slow breath in through your nose... As you prepare for the exhale, open your mouth softly... Now, as you exhale, let the breath flow out gently through your mouth, releasing any tension in your jaw. Exhale completely... Take another slow breath in through your nose... Prepare yourself... Open your mouth, and let the breath release, soft and unhurried. Breathe in again, slowly... This time, as you exhale, imagine you're releasing tension... releasing stress... releasing worry. Let it go, gently. Inhale once more, slowly... Exhale fully, with calm intention. Feel the tension melting away. One more time. Breathe in deeply... Exhale slowly, releasing everything you need to let go of. Wonderful. After this practice, take some gentle, normal breaths. Feel the calm settling into your body. You've completed your Lion's Breath session.",
  },
  {
    name: "Extended Exhale",
    description: "Longer exhales activate the parasympathetic nervous system for deep relaxation.",
    script: "Welcome... to extended exhale breathing, a deeply relaxing technique. Find a comfortable position, sitting or lying down. This practice uses a longer exhale than inhale, which naturally calms your nervous system. Let's begin. Inhale through your nose. One... Two... Three... Now exhale through your mouth, slowly. One... Two... Three... Four... Five... Six... Feel your body relax as you extend the exhale. Inhale. One... Two... Three... Exhale. One... Two... Three... Four... Five... Six... Continue this beautiful rhythm. As you exhale, let your shoulders drop... let your jaw relax. Inhale. One... Two... Three... Exhale. One... Two... Three... Four... Five... Six... Each exhale deepens your relaxation. Inhale. One... Two... Three... Exhale. One... Two... Three... Four... Five... Six... You're doing beautifully. Keep breathing this way... Feel yourself sinking deeper into calm with each breath. When you're ready, take normal breaths... and rest in this peaceful state.",
  },
];

const DEEPER_SESSION_GUIDE_SCRIPT =
  "Welcome to this guided breathing meditation... Find a comfortable position, seated or lying down, wherever feels supportive to you right now... Gently close your eyes, if that feels right... and take a moment to arrive fully in this space... Let's begin with a slow, natural breath in... and a slow release out... Nothing to force, just allowing your body to settle... Now, breathe in gently through your nose... One... Two... Three... Four... And hold, softly... One... Two... Three... Four... Now release the breath slowly through your mouth... One... Two... Three... Four... Five... Six... Feel your shoulders soften with each exhale... Let's continue this rhythm together... Inhale... One... Two... Three... Four... Hold... One... Two... Three... Four... Exhale, slowly... One... Two... Three... Four... Five... Six... With each breath, allow yourself to sink a little deeper into calm... There is nowhere else you need to be... nothing else you need to do... just this breath... Inhale, gently... One... Two... Three... Four... Hold... One... Two... Three... Four... Exhale, releasing fully... One... Two... Three... Four... Five... Six... Notice the quiet between each breath... that small, peaceful pause... Continue at your own pace now... breathing in deeply... and releasing slowly... letting each exhale carry away any tension you're holding... Inhale... One... Two... Three... Four... Exhale, long and slow... One... Two... Three... Four... Five... Six... You're doing beautifully... Allow your whole body to soften... your jaw, your shoulders, your hands... Continue breathing this way, at whatever pace feels good for you... There's no rush here... only this moment, and the gentle rhythm of your breath... When thoughts arise, simply notice them... and let them pass, like clouds... returning your attention to your breath... Inhale, slowly... Exhale, even more slowly... Continue resting in this peaceful rhythm for as long as you'd like... breathing in calm... and breathing out anything you no longer need... You are safe... You are supported... You are exactly where you need to be...";

const BACKGROUND_SOUNDS = [
  { day: 0, name: "Soothing Tones", url: "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/mp3/main%20track.mp3" },
  { day: 1, name: "Dreamers", url: "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Dreamers%20(MP3).mp3" },
  { day: 2, name: "Peaceful Singing Bowls", url: "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Singing%20Bowl%20Meditation.mp3" },
  { day: 3, name: "Meditation", url: "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Meditation.mp3" },
  { day: 4, name: "Sleep Tones", url: "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Soothing%20Sleep%20Music.wav" },
  { day: 5, name: "Forest Breeze", url: "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/LDj_Audio_ForestLightBreezeAmbience_V1.wav" },
  { day: 6, name: "Soothing Tones", url: "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/mp3/main%20track.mp3" },
];

// Get today's breathwork script
router.get("/today", async (req, res) => {
  try {
    const dayOfWeek = new Date().getDay();
    const breathworkIndex = dayOfWeek % BREATHWORK_TYPES.length;
    const todayBreathwork = BREATHWORK_TYPES[breathworkIndex];
    const bgSound = BACKGROUND_SOUNDS[dayOfWeek];

    res.json({
      title: todayBreathwork.name,
      description: todayBreathwork.description,
      script: todayBreathwork.script,
      duration: 5,
      backgroundSound: bgSound.name,
      backgroundSoundUrl: bgSound.url,
    });
  } catch (err) {
    console.error("[BREATHWORK] Error getting today's breathwork:", err);
    res.status(500).json({ error: "Failed to get breathwork" });
  }
});

// Generate TTS audio for daily breathwork
async function generateDailyTTS(): Promise<Buffer> {
  const dayOfWeek = new Date().getDay();
  const cacheKey = `day-${dayOfWeek}`;

  // Return cached audio if available
  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey)!;
  }

  const breathworkIndex = dayOfWeek % BREATHWORK_TYPES.length;
  const todayBreathwork = BREATHWORK_TYPES[breathworkIndex];

  try {
    console.log(`[BREATHWORK] Generating TTS for ${todayBreathwork.name}...`);
    const mp3 = await openai.audio.speech.create({
      model: "tts-1",
      voice: "shimmer",
      input: todayBreathwork.script,
      speed: 0.78, // Slow, soothing pace so counted breaths land closer to real seconds
    });

    const buffer = Buffer.from(await mp3.arrayBuffer());
    ttsCache.set(cacheKey, buffer);
    console.log(`[BREATHWORK] Generated ${buffer.length} bytes of TTS audio`);
    return buffer;
  } catch (err) {
    console.error("[BREATHWORK] TTS generation failed:", err);
    throw err;
  }
}

// Get daily breathwork audio (female voice guiding through today's breathing)
router.get("/audio/daily", async (req, res): Promise<any> => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      console.warn("[BREATHWORK] No OpenAI API key configured, returning background sound only");
      const dayOfWeek = new Date().getDay();
      const bgSound = BACKGROUND_SOUNDS[dayOfWeek];
      return res.redirect(bgSound.url);
    }

    try {
      const audioBuffer = await generateDailyTTS();
      res.setHeader("Content-Type", "audio/mpeg");
      res.setHeader("Cache-Control", "public, max-age=86400"); // Cache for 24 hours
      res.send(audioBuffer);
    } catch (ttsErr) {
      console.error("[BREATHWORK] TTS generation failed, falling back to background sound:", ttsErr);
      const dayOfWeek = new Date().getDay();
      const bgSound = BACKGROUND_SOUNDS[dayOfWeek];
      res.redirect(bgSound.url);
    }
  } catch (err) {
    console.error("[BREATHWORK] Error getting daily audio:", err);
    res.status(500).json({ error: "Failed to generate audio" });
  }
});

// Generate (and cache) the generic guide-voice track layered over Deeper Session background music
let sessionGuideCache: Buffer | null = null;

async function generateSessionGuideTTS(): Promise<Buffer> {
  if (sessionGuideCache) return sessionGuideCache;

  console.log("[BREATHWORK] Generating Deeper Session guide voice TTS...");
  const mp3 = await openai.audio.speech.create({
    model: "tts-1",
    voice: "shimmer",
    input: DEEPER_SESSION_GUIDE_SCRIPT,
    speed: 0.78,
  });

  const buffer = Buffer.from(await mp3.arrayBuffer());
  sessionGuideCache = buffer;
  console.log(`[BREATHWORK] Generated ${buffer.length} bytes of session guide TTS`);
  return buffer;
}

// Get the guide-voice track to layer over a Deeper Session's looping background music
router.get("/audio/session-guide", async (req, res): Promise<any> => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(404).json({ error: "Voice guidance unavailable" });
    }
    const audioBuffer = await generateSessionGuideTTS();
    res.setHeader("Content-Type", "audio/mpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(audioBuffer);
  } catch (err) {
    console.error("[BREATHWORK] Session guide TTS generation failed:", err);
    res.status(500).json({ error: "Failed to generate guide audio" });
  }
});

// Get all stored longer breathwork sessions
router.get("/sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, duration_minutes, title, description, audio_url FROM guided_breathwork ORDER BY duration_minutes, sort_order"
    );
    res.json({ sessions: rows });
  } catch (err) {
    console.error("[BREATHWORK] Error getting sessions:", err);
    res.status(500).json({ error: "Failed to get sessions" });
  }
});

// Get a specific stored session by ID
router.get("/sessions/:id", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, duration_minutes, title, description, audio_url FROM guided_breathwork WHERE id = $1",
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: "Session not found" });
    }
    res.json({ session: rows[0] });
  } catch (err) {
    console.error("[BREATHWORK] Error getting session:", err);
    res.status(500).json({ error: "Failed to get session" });
  }
});

// Admin: Add a new stored breathwork session
router.post("/sessions", async (req, res) => {
  try {
    const { duration_minutes, title, description, audio_url, sort_order } = req.body;
    if (!duration_minutes || !title || !audio_url) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const { rows } = await pool.query(
      "INSERT INTO guided_breathwork (duration_minutes, title, description, audio_url, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id",
      [duration_minutes, title, description || null, audio_url, sort_order || 0]
    );

    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error("[BREATHWORK] Error creating session:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// Admin: Update a stored breathwork session
router.put("/sessions/:id", async (req, res) => {
  try {
    const { title, description, audio_url, sort_order } = req.body;
    await pool.query(
      "UPDATE guided_breathwork SET title = COALESCE($1, title), description = COALESCE($2, description), audio_url = COALESCE($3, audio_url), sort_order = COALESCE($4, sort_order) WHERE id = $5",
      [title || null, description || null, audio_url || null, sort_order || null, req.params.id]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[BREATHWORK] Error updating session:", err);
    res.status(500).json({ error: "Failed to update session" });
  }
});

// Admin: Delete a stored breathwork session
router.delete("/sessions/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM guided_breathwork WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("[BREATHWORK] Error deleting session:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// Admin: Initialize default breathwork sessions (call once to seed the database)
router.post("/init-defaults", async (req, res) => {
  try {
    const peacefulSounds = [
      "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Dreamers%20(MP3).mp3",
      "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Singing%20Bowl%20Meditation.mp3",
      "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Meditation.mp3",
      "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/Soothing%20Sleep%20Music.wav",
      "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/LDj_Audio_ForestLightBreezeAmbience_V1.wav",
      "https://WELLCOLLECTIVESOUNDTRACK.b-cdn.net/Peaceful%20Sounds/mp3/main%20track.mp3",
    ];

    const soundNames = [
      "Dreamers",
      "Peaceful Singing Bowls",
      "Meditation",
      "Sleep Tones",
      "Forest Breeze",
      "Soothing Tones",
    ];

    // Clear existing sessions
    await pool.query("DELETE FROM guided_breathwork");

    // Create 3 x 10-minute sessions
    for (let i = 0; i < 3; i++) {
      const soundIdx = i % soundNames.length;
      await pool.query(
        "INSERT INTO guided_breathwork (duration_minutes, title, description, audio_url, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [
          10,
          `Breathwork with ${soundNames[soundIdx]}`,
          `10-minute guided breathing with ${soundNames[soundIdx]} in the background`,
          peacefulSounds[soundIdx],
          i,
        ]
      );
    }

    // Create 3 x 15-minute sessions
    for (let i = 0; i < 3; i++) {
      const soundIdx = (i + 1) % soundNames.length;
      await pool.query(
        "INSERT INTO guided_breathwork (duration_minutes, title, description, audio_url, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [
          15,
          `Deep Breathwork with ${soundNames[soundIdx]}`,
          `15-minute deep breathing practice with ${soundNames[soundIdx]} in the background`,
          peacefulSounds[soundIdx],
          i,
        ]
      );
    }

    // Create 3 x 30-minute sessions
    for (let i = 0; i < 3; i++) {
      const soundIdx = (i + 2) % soundNames.length;
      await pool.query(
        "INSERT INTO guided_breathwork (duration_minutes, title, description, audio_url, sort_order) VALUES ($1, $2, $3, $4, $5)",
        [
          30,
          `Extended Breathwork with ${soundNames[soundIdx]}`,
          `30-minute extended breathing meditation with ${soundNames[soundIdx]} in the background`,
          peacefulSounds[soundIdx],
          i,
        ]
      );
    }

    res.json({ ok: true, message: "Initialized 9 default breathwork sessions" });
  } catch (err) {
    console.error("[BREATHWORK] Error initializing defaults:", err);
    res.status(500).json({ error: "Failed to initialize sessions" });
  }
});

export default router;
