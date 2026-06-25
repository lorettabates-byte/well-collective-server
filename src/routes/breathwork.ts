import { Router } from "express";
import { pool } from "../db";
import { buildScriptAudio, type ScriptSegment } from "../utils/ttsAudioBuilder";

const router = Router();

// Cache for generated TTS audio (key -> buffer)
const ttsCache = new Map<string, Buffer>();

const s = (text: string): ScriptSegment => ({ type: "speech", text });
const c = (from: number, to: number): ScriptSegment => ({ type: "count", from, to });

// Standardized short cues so the in-memory speech cache (see ttsAudioBuilder)
// reuses the same rendered clip across every script instead of re-synthesizing
// "Inhale." dozens of times.
const INHALE = s("Inhale.");
const HOLD = s("Hold.");
const EXHALE = s("Exhale.");

function segmentsToDisplayText(segments: ScriptSegment[]): string {
  return segments
    .map((seg) => {
      if (seg.type === "speech") return seg.text;
      if (seg.type === "count") return Array.from({ length: seg.to - seg.from + 1 }, (_, i) => seg.from + i).join(", ");
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

const BREATHWORK_TYPES: { name: string; description: string; segments: ScriptSegment[] }[] = [
  {
    name: "Box Breathing",
    description: "Inhale for 4 counts, hold for 4 counts, exhale for 4 counts, hold for 4 counts. Repeat 5 times.",
    segments: [
      s("Welcome to today's guided box breathing exercise."),
      s("Box breathing helps calm your nervous system and improve focus."),
      s("Find a comfortable position and close your eyes if you'd like."),
      s("Take a moment to settle in."),
      INHALE, c(1, 4),
      HOLD, c(1, 4),
      EXHALE, c(1, 4),
      HOLD, c(1, 4),
      s("Good, let's continue."),
      INHALE, c(1, 4),
      HOLD, c(1, 4),
      EXHALE, c(1, 4),
      HOLD, c(1, 4),
      s("Continue at your own pace with this rhythm."),
      INHALE, c(1, 4),
      HOLD, c(1, 4),
      EXHALE, c(1, 4),
      HOLD, c(1, 4),
      s("Beautiful. Each breath is bringing you deeper into calm."),
      s("When you're ready, take three natural breaths and gently open your eyes."),
      s("You've completed your box breathing exercise."),
    ],
  },
  {
    name: "Diaphragmatic Breathing",
    description: "Deep belly breathing to activate your parasympathetic nervous system. Breathe in for 4 counts, out for 6 counts.",
    segments: [
      s("Welcome to diaphragmatic breathing."),
      s("This technique helps reduce stress and promotes deep relaxation."),
      s("Find a comfortable seated or lying position."),
      s("You can place one hand on your chest and one on your belly."),
      s("As you inhale through your nose, let the breath travel down into your belly, allowing it to expand."),
      c(1, 4),
      EXHALE, c(1, 6),
      s("Feel your belly fall as you release the breath."),
      INHALE, c(1, 4),
      EXHALE, c(1, 6),
      s("The exhale is longer than the inhale, which signals your body to relax."),
      INHALE, c(1, 4),
      EXHALE, c(1, 6),
      s("Feel yourself becoming more and more relaxed with each breath."),
      INHALE, c(1, 4),
      EXHALE, c(1, 6),
      s("You're doing beautifully."),
      s("When you're ready, take a few natural breaths and gently return to your day."),
    ],
  },
  {
    name: "4-7-8 Breathing",
    description: "A calming technique: inhale for 4, hold for 7, exhale for 8. Perfect before sleep.",
    segments: [
      s("Welcome to the 4, 7, 8 breathing technique, designed to calm your mind and prepare your body for rest."),
      s("Find a comfortable position, seated or lying down."),
      s("Start by exhaling completely through your mouth, slow and soft."),
      s("Now, close your mouth and inhale quietly through your nose."),
      c(1, 4),
      HOLD, c(1, 7),
      EXHALE, c(1, 8),
      s("Let's do that again."),
      INHALE, c(1, 4),
      HOLD, c(1, 7),
      EXHALE, c(1, 8),
      s("Continue with this rhythm."),
      INHALE, c(1, 4),
      HOLD, c(1, 7),
      EXHALE, c(1, 8),
      s("Feel the calm washing over you."),
      s("This technique is wonderful before bedtime."),
      s("When you're complete, take normal breaths and allow yourself to rest peacefully."),
    ],
  },
  {
    name: "Alternate Nostril Breathing",
    description: "Balance your energy: alternate between breathing through left and right nostrils.",
    segments: [
      s("Welcome to alternate nostril breathing, a balancing technique that harmonizes your body and mind."),
      s("Sit comfortably with your spine straight."),
      s("Fold your index and middle fingers down, leaving your thumb and ring finger extended."),
      s("Close your right nostril with your thumb and inhale through your left nostril."),
      c(1, 4),
      s("Release your thumb, close your left nostril with your ring finger, and exhale through your right nostril."),
      c(1, 4),
      s("Inhale through the right nostril."),
      c(1, 4),
      s("Switch, close your right nostril, and exhale through the left."),
      c(1, 4),
      s("That's one complete cycle. Let's continue."),
      s("Inhale left."),
      c(1, 4),
      s("Switch, exhale right."),
      c(1, 4),
      s("Inhale right."),
      c(1, 4),
      s("Switch, exhale left."),
      c(1, 4),
      s("Wonderful. Feel yourself becoming more centered and calm."),
      s("When you're ready, return to normal breathing with both nostrils."),
      s("You've completed your alternate nostril breathing."),
    ],
  },
  {
    name: "Coherent Breathing",
    description: "5-second inhale, 5-second exhale. Synchronizes heart rate variability.",
    segments: [
      s("Welcome to coherent breathing, a gentle technique that brings your body into a state of balance and ease."),
      s("Find a comfortable position."),
      s("Let's begin with a few normal breaths to settle in."),
      INHALE, c(1, 5),
      EXHALE, c(1, 5),
      s("The breath is equal in and out, creating a beautiful rhythm."),
      INHALE, c(1, 5),
      EXHALE, c(1, 5),
      s("This simple pattern has profound effects on your nervous system."),
      INHALE, c(1, 5),
      EXHALE, c(1, 5),
      s("Feel your heart rate synchronizing with your breath. You're in perfect coherence."),
      INHALE, c(1, 5),
      EXHALE, c(1, 5),
      s("This is your anchor, your place of calm."),
      s("When you're ready, let your breath return to normal and rest in this peaceful state."),
    ],
  },
  {
    name: "Lion's Breath",
    description: "Energizing exhale with open mouth and tongue out. Great for releasing tension.",
    segments: [
      s("Welcome to Lion's Breath, a gentle yet invigorating technique that helps release tension."),
      s("Find a comfortable seated position."),
      s("Take a slow breath in through your nose."),
      s("As you exhale, let the breath flow out gently through your mouth, releasing any tension in your jaw."),
      s("Take another slow breath in through your nose."),
      s("Open your mouth and let the breath release, soft and unhurried."),
      s("Breathe in again, slowly."),
      s("As you exhale, imagine you're releasing tension, releasing stress, releasing worry."),
      s("Inhale once more, slowly."),
      s("Exhale fully, with calm intention. Feel the tension melting away."),
      s("One more time. Breathe in deeply."),
      s("Exhale slowly, releasing everything you need to let go of."),
      s("Wonderful. After this practice, take some gentle, normal breaths."),
      s("Feel the calm settling into your body."),
      s("You've completed your Lion's Breath session."),
    ],
  },
  {
    name: "Extended Exhale",
    description: "Longer exhales activate the parasympathetic nervous system for deep relaxation.",
    segments: [
      s("Welcome to extended exhale breathing, a deeply relaxing technique."),
      s("Find a comfortable position, sitting or lying down."),
      s("This practice uses a longer exhale than inhale, which naturally calms your nervous system."),
      INHALE, c(1, 3),
      EXHALE, c(1, 6),
      s("Feel your body relax as you extend the exhale."),
      INHALE, c(1, 3),
      EXHALE, c(1, 6),
      s("As you exhale, let your shoulders drop and let your jaw relax."),
      INHALE, c(1, 3),
      EXHALE, c(1, 6),
      s("Each exhale deepens your relaxation."),
      INHALE, c(1, 3),
      EXHALE, c(1, 6),
      s("You're doing beautifully."),
      s("When you're ready, take normal breaths and rest in this peaceful state."),
    ],
  },
];

// Nine distinct Deeper Session guide-voice scripts, one per stored session, so
// every session has its own track instead of all nine sharing the same recording.
const DEEPER_SESSION_GUIDES: ScriptSegment[][] = [
  // 1
  [
    s("Welcome to this guided breathing meditation."),
    s("Find a comfortable position, seated or lying down, wherever feels supportive right now."),
    s("Gently close your eyes, if that feels right, and take a moment to arrive in this space."),
    INHALE, c(1, 4),
    HOLD, c(1, 4),
    EXHALE, c(1, 6),
    s("Feel your shoulders soften with each exhale."),
    INHALE, c(1, 4),
    HOLD, c(1, 4),
    EXHALE, c(1, 6),
    s("With each breath, allow yourself to sink a little deeper into calm."),
    INHALE, c(1, 4),
    HOLD, c(1, 4),
    EXHALE, c(1, 6),
    s("There is nowhere else you need to be, nothing else you need to do, just this breath."),
    INHALE, c(1, 4),
    HOLD, c(1, 4),
    EXHALE, c(1, 6),
    s("Continue resting in this peaceful rhythm for as long as you'd like."),
    s("You are safe. You are supported. You are exactly where you need to be."),
  ],
  // 2
  [
    s("Welcome back to your practice."),
    s("Settle into a position that feels easy for your body, and let your eyes soften or close."),
    s("We'll begin with a slow breath in through the nose."),
    INHALE, c(1, 5),
    EXHALE, c(1, 5),
    s("Notice the quiet pause between each breath."),
    INHALE, c(1, 5),
    EXHALE, c(1, 5),
    s("Let your jaw unclench, let your hands rest open."),
    INHALE, c(1, 5),
    EXHALE, c(1, 5),
    s("Each breath is an invitation to release a little more."),
    INHALE, c(1, 5),
    EXHALE, c(1, 5),
    s("There's nothing to fix here, only this rhythm, breath after breath."),
    s("Stay here as long as feels good, returning to this pace whenever your mind wanders."),
  ],
  // 3
  [
    s("Welcome. Let's spend this time together, slowing down."),
    s("Find stillness in your body, and let your breath lead the way."),
    INHALE, c(1, 4),
    HOLD, c(1, 5),
    EXHALE, c(1, 7),
    s("Feel the natural pause after each release."),
    INHALE, c(1, 4),
    HOLD, c(1, 5),
    EXHALE, c(1, 7),
    s("Let go of anything you've been holding onto today."),
    INHALE, c(1, 4),
    HOLD, c(1, 5),
    EXHALE, c(1, 7),
    s("Your body already knows how to do this. Just let it happen."),
    s("Continue at this gentle pace, allowing the quiet to settle in around you."),
  ],
  // 4
  [
    s("Welcome to this space of rest."),
    s("Let your body be heavy, supported by whatever is beneath you."),
    INHALE, c(1, 4),
    EXHALE, c(1, 4),
    s("A simple, even breath, in and out."),
    INHALE, c(1, 4),
    EXHALE, c(1, 4),
    s("With every exhale, let a little more tension melt away."),
    INHALE, c(1, 4),
    EXHALE, c(1, 4),
    s("Nothing to achieve here, only presence."),
    INHALE, c(1, 4),
    EXHALE, c(1, 4),
    s("Let this rhythm carry you, breath by breath, for as long as you need."),
  ],
  // 5
  [
    s("Welcome. Take a moment to notice how you're feeling right now, without judgment."),
    s("When you're ready, let's begin to slow the breath together."),
    INHALE, c(1, 5),
    HOLD, c(1, 3),
    EXHALE, c(1, 6),
    s("Feel your chest and belly rise and fall naturally."),
    INHALE, c(1, 5),
    HOLD, c(1, 3),
    EXHALE, c(1, 6),
    s("Each cycle brings you further into stillness."),
    INHALE, c(1, 5),
    HOLD, c(1, 3),
    EXHALE, c(1, 6),
    s("You don't have to do anything else right now. Just breathe."),
    s("Stay with this rhythm, resting in the calm it creates."),
  ],
  // 6
  [
    s("Welcome to this quiet moment."),
    s("Let your shoulders drop away from your ears, and soften your face."),
    INHALE, c(1, 4),
    EXHALE, c(1, 8),
    s("Notice how much longer the exhale is. That's intentional. It tells your body it's safe to relax."),
    INHALE, c(1, 4),
    EXHALE, c(1, 8),
    s("Let each breath wash a little more calm through your body."),
    INHALE, c(1, 4),
    EXHALE, c(1, 8),
    s("There's no rush here, only this slow unwinding."),
    s("Continue breathing this way for as long as feels good."),
  ],
  // 7
  [
    s("Welcome. Let's take this time to simply be."),
    s("Find a position where your body feels supported and at ease."),
    INHALE, c(1, 4),
    HOLD, c(1, 4),
    EXHALE, c(1, 4),
    HOLD, c(1, 4),
    s("This even, steady rhythm helps settle a busy mind."),
    INHALE, c(1, 4),
    HOLD, c(1, 4),
    EXHALE, c(1, 4),
    HOLD, c(1, 4),
    s("Each pause is a small rest within the breath itself."),
    INHALE, c(1, 4),
    HOLD, c(1, 4),
    EXHALE, c(1, 4),
    HOLD, c(1, 4),
    s("Continue this gentle square of breath, in your own time."),
  ],
  // 8
  [
    s("Welcome to your practice today."),
    s("Let your attention come fully into your body, right here, right now."),
    INHALE, c(1, 6),
    EXHALE, c(1, 6),
    s("An easy, balanced breath, equal in and equal out."),
    INHALE, c(1, 6),
    EXHALE, c(1, 6),
    s("Let your thoughts drift by like clouds, without needing to follow them."),
    INHALE, c(1, 6),
    EXHALE, c(1, 6),
    s("Simply return to the breath, again and again."),
    s("Rest here in this steady, peaceful rhythm."),
  ],
  // 9
  [
    s("Welcome. This is your time to slow down completely."),
    s("Let your whole body soften into stillness."),
    INHALE, c(1, 4),
    HOLD, c(1, 6),
    EXHALE, c(1, 8),
    s("Feel the calm that builds with every cycle."),
    INHALE, c(1, 4),
    HOLD, c(1, 6),
    EXHALE, c(1, 8),
    s("There's nowhere to be but here."),
    INHALE, c(1, 4),
    HOLD, c(1, 6),
    EXHALE, c(1, 8),
    s("Let this rhythm hold you, breath after breath, for as long as you'd like."),
  ],
];

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
      script: segmentsToDisplayText(todayBreathwork.segments),
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

  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey)!;
  }

  const breathworkIndex = dayOfWeek % BREATHWORK_TYPES.length;
  const todayBreathwork = BREATHWORK_TYPES[breathworkIndex];

  console.log(`[BREATHWORK] Building TTS for ${todayBreathwork.name}...`);
  const buffer = await buildScriptAudio(todayBreathwork.segments);
  ttsCache.set(cacheKey, buffer);
  console.log(`[BREATHWORK] Built ${buffer.length} bytes of TTS audio`);
  return buffer;
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
      if (req.query.debug) {
        return res.status(500).json({ error: String((ttsErr as Error)?.message || ttsErr), stack: (ttsErr as Error)?.stack });
      }
      const dayOfWeek = new Date().getDay();
      const bgSound = BACKGROUND_SOUNDS[dayOfWeek];
      res.redirect(bgSound.url);
    }
  } catch (err) {
    console.error("[BREATHWORK] Error getting daily audio:", err);
    res.status(500).json({ error: "Failed to generate audio" });
  }
});

// Generate (and cache) the guide-voice track for a specific Deeper Session
const sessionGuideCache = new Map<number, Buffer>();

async function generateSessionGuideTTS(guideIndex: number): Promise<Buffer> {
  if (sessionGuideCache.has(guideIndex)) return sessionGuideCache.get(guideIndex)!;

  console.log(`[BREATHWORK] Building Deeper Session guide voice #${guideIndex}...`);
  const buffer = await buildScriptAudio(DEEPER_SESSION_GUIDES[guideIndex]);
  sessionGuideCache.set(guideIndex, buffer);
  console.log(`[BREATHWORK] Built ${buffer.length} bytes for guide #${guideIndex}`);
  return buffer;
}

// Get the guide-voice track to layer over a Deeper Session's looping background music.
// :id is the stored session's database id; each session maps to its own unique script.
router.get("/audio/session-guide/:id", async (req, res): Promise<any> => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(404).json({ error: "Voice guidance unavailable" });
    }
    const sessionId = parseInt(req.params.id, 10) || 0;
    const guideIndex = sessionId % DEEPER_SESSION_GUIDES.length;
    const audioBuffer = await generateSessionGuideTTS(guideIndex);
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
