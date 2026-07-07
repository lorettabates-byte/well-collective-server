import { Request, Response, Router } from "express";
import { pool } from "../db";
import { buildScriptAudio, estimateSeconds, isTtsConfigured, type ScriptSegment } from "../utils/ttsAudioBuilder";

const router = Router();

// iOS (WKWebView) audio elements require real HTTP Range support to seek —
// without a 206 Partial Content response, setting `.currentTime` in JS
// silently fails even though the UI slider updates optimistically. Serving
// the whole buffer via res.send() (no Accept-Ranges) is what caused the
// "scrubber moves but the audio doesn't" bug on longer sessions.
function sendAudioBuffer(req: Request, res: Response, buffer: Buffer): void {
  const range = req.headers.range;
  const total = buffer.length;

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Accept-Ranges", "bytes");

  if (!range) {
    res.setHeader("Content-Length", total);
    res.end(buffer);
    return;
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  const start = match?.[1] ? parseInt(match[1], 10) : 0;
  const end = match?.[2] ? parseInt(match[2], 10) : total - 1;
  const chunkStart = Math.max(0, Math.min(start, total - 1));
  const chunkEnd = Math.max(chunkStart, Math.min(end, total - 1));

  res.status(206);
  res.setHeader("Content-Range", `bytes ${chunkStart}-${chunkEnd}/${total}`);
  res.setHeader("Content-Length", chunkEnd - chunkStart + 1);
  res.end(buffer.subarray(chunkStart, chunkEnd + 1));
}

// Returns 0-6 (Sun-Sat) using Eastern Time so breathwork switches at midnight
// ET, not midnight UTC (which would be 7-8 hours too early for members).
function etDayOfWeek(): number {
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date());
  const idx = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(label);
  return idx >= 0 ? idx : new Date().getDay();
}

// Cache for generated TTS audio (key -> buffer).
// Bump CACHE_VERSION after changing scripts to force regeneration.
const CACHE_VERSION = 2;
const ttsCache = new Map<string, Buffer>();

const s = (text: string): ScriptSegment => ({ type: "speech", text });
const c = (from: number, to: number): ScriptSegment => ({ type: "count", from, to });
const p = (ms: number): ScriptSegment => ({ type: "pause", ms });

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

// Each practice is defined as intro + one repeatable breathing cycle +
// rotating encouragement lines + outro, and buildTimedSegments repeats the
// cycle until the script genuinely fills the advertised duration — the old
// fixed scripts only held 2-4 cycles and ran ~90 seconds against a promised
// 5 minutes.
interface TimedBreathwork {
  name: string;
  description: string;
  intro: ScriptSegment[];
  cycle: ScriptSegment[];
  interludes: string[];
  outro: ScriptSegment[];
}

function buildTimedSegments(t: TimedBreathwork, targetSeconds: number): ScriptSegment[] {
  const segments: ScriptSegment[] = [...t.intro];
  const outroSeconds = estimateSeconds(t.outro);
  let interludeIdx = 0;
  let cyclesSinceInterlude = 0;

  while (estimateSeconds(segments) + outroSeconds < targetSeconds) {
    segments.push(...t.cycle);
    cyclesSinceInterlude++;
    if (
      cyclesSinceInterlude >= 2 &&
      t.interludes.length > 0 &&
      estimateSeconds(segments) + outroSeconds + 8 < targetSeconds
    ) {
      segments.push(s(t.interludes[interludeIdx % t.interludes.length]));
      interludeIdx++;
      cyclesSinceInterlude = 0;
    }
  }

  segments.push(...t.outro);
  return segments;
}

const DAILY_TARGET_SECONDS = 5 * 60;

const BREATHWORK_TYPES: TimedBreathwork[] = [
  {
    name: "Box Breathing",
    description: "Inhale for 4 counts, hold for 4 counts, exhale for 4 counts, hold for 4 counts.",
    intro: [
      s("Welcome to today's guided box breathing exercise."),
      s("Box breathing helps calm your nervous system and improve focus."),
      s("Find a comfortable position and close your eyes if you'd like."),
      s("Take a moment to settle in."),
      p(3000),
    ],
    cycle: [
      INHALE, c(1, 4),
      HOLD, c(1, 4),
      EXHALE, c(1, 4),
      HOLD, c(1, 4),
    ],
    interludes: [
      "Good, let's continue.",
      "Continue at your own pace with this rhythm.",
      "Each breath is bringing you deeper into calm.",
      "Let your shoulders soften.",
      "You're doing beautifully.",
      "Notice how your body is settling in.",
      "There's nothing you need to do right now but breathe.",
      "Feel the rhythm becoming more natural with every cycle.",
      "Let any tension in your face melt away.",
      "You're giving yourself a gift right now.",
    ],
    outro: [
      s("Beautiful. Each breath has brought you deeper into calm."),
      s("When you're ready, take three natural breaths and gently open your eyes."),
      s("You've completed your box breathing exercise."),
    ],
  },
  {
    name: "Diaphragmatic Breathing",
    description: "Deep belly breathing to activate your parasympathetic nervous system. Breathe in for 4 counts, out for 6 counts.",
    intro: [
      s("Welcome to diaphragmatic breathing."),
      s("This technique helps reduce stress and promotes deep relaxation."),
      s("Find a comfortable seated or lying position."),
      s("You can place one hand on your chest and one on your belly."),
      s("As you inhale through your nose, let the breath travel down into your belly, allowing it to expand."),
      p(3000),
    ],
    cycle: [
      INHALE, c(1, 4),
      EXHALE, c(1, 6),
    ],
    interludes: [
      "Feel your belly fall as you release the breath.",
      "The exhale is longer than the inhale, which signals your body to relax.",
      "Feel yourself becoming more and more relaxed with each breath.",
      "Let your thoughts drift by, and return to the breath.",
      "You're doing beautifully.",
      "Notice your belly rising and falling, like gentle waves.",
      "Each breath is a small act of self-care.",
      "Let your hands rest open and your arms feel heavy.",
      "You deserve this quiet moment.",
      "Feel the warmth spreading through your body.",
    ],
    outro: [
      s("Wonderful work."),
      s("When you're ready, take a few natural breaths and gently return to your day."),
    ],
  },
  {
    name: "4-7-8 Breathing",
    description: "A calming technique: inhale for 4, hold for 7, exhale for 8. Perfect before sleep.",
    intro: [
      s("Welcome to the 4, 7, 8 breathing technique, designed to calm your mind and prepare your body for rest."),
      s("Find a comfortable position, seated or lying down."),
      s("Start by exhaling completely through your mouth, slow and soft."),
      p(3000),
    ],
    cycle: [
      INHALE, c(1, 4),
      HOLD, c(1, 7),
      EXHALE, c(1, 8),
    ],
    interludes: [
      "Continue with this rhythm.",
      "Feel the calm washing over you.",
      "Let each exhale carry away a little more tension.",
      "Your body is settling deeper into rest.",
      "This technique is perfect for winding down before sleep.",
      "Let your eyelids feel heavy and your breath carry you.",
      "You're doing wonderful.",
      "Each cycle brings you closer to deep, restful calm.",
      "Allow the long exhale to empty everything you don't need.",
    ],
    outro: [
      s("This technique is wonderful before bedtime."),
      s("When you're complete, take normal breaths and allow yourself to rest peacefully."),
    ],
  },
  {
    name: "Alternate Nostril Breathing",
    description: "Balance your energy: alternate between breathing through left and right nostrils.",
    intro: [
      s("Welcome to alternate nostril breathing, a balancing technique that harmonizes your body and mind."),
      s("Sit comfortably with your spine straight."),
      s("Fold your index and middle fingers down, leaving your thumb and ring finger extended."),
      s("Close your right nostril with your thumb and inhale through your left nostril."),
      c(1, 4),
      s("Release your thumb, close your left nostril with your ring finger, and exhale through your right nostril."),
      c(1, 4),
      s("That's the pattern. Let's continue together."),
    ],
    cycle: [
      s("Inhale left."), c(1, 4),
      s("Switch, exhale right."), c(1, 4),
      s("Inhale right."), c(1, 4),
      s("Switch, exhale left."), c(1, 4),
    ],
    interludes: [
      "Feel yourself becoming more centered with each cycle.",
      "Keep your breath smooth and unhurried.",
      "Beautiful. Stay with this gentle rhythm.",
      "Notice how balanced you feel, left side and right side finding harmony.",
      "This ancient technique has been calming minds for thousands of years.",
      "Let each nostril carry a different quality of calm.",
      "You're creating balance with every breath.",
      "Feel the stillness growing inside you.",
    ],
    outro: [
      s("Wonderful. Feel yourself centered and calm."),
      s("When you're ready, return to normal breathing with both nostrils."),
      s("You've completed your alternate nostril breathing."),
    ],
  },
  {
    name: "Coherent Breathing",
    description: "5-second inhale, 5-second exhale. Synchronizes heart rate variability.",
    intro: [
      s("Welcome to coherent breathing, a gentle technique that brings your body into a state of balance and ease."),
      s("Find a comfortable position."),
      s("Let's begin with a few normal breaths to settle in."),
      p(4000),
    ],
    cycle: [
      INHALE, c(1, 5),
      EXHALE, c(1, 5),
    ],
    interludes: [
      "The breath is equal in and out, creating a beautiful rhythm.",
      "This simple pattern has profound effects on your nervous system.",
      "Feel your heart rate synchronizing with your breath.",
      "This is your anchor, your place of calm.",
      "Simply stay with the rhythm.",
      "Your body is finding its natural resonance.",
      "In and out, like the tide, steady and sure.",
      "Let this become effortless.",
      "You're exactly where you need to be right now.",
      "Feel the peace that comes from this simple, steady rhythm.",
    ],
    outro: [
      s("You're in perfect coherence."),
      s("When you're ready, let your breath return to normal and rest in this peaceful state."),
    ],
  },
  {
    name: "Lion's Breath",
    description: "Energizing exhale with open mouth. Great for releasing tension.",
    intro: [
      s("Welcome to Lion's Breath, a gentle yet invigorating technique that helps release tension."),
      s("Find a comfortable seated position."),
      p(3000),
    ],
    cycle: [
      s("Take a slow breath in through your nose."),
      p(4000),
      s("As you exhale, let the breath flow out gently through your mouth, releasing any tension in your jaw."),
      p(5000),
    ],
    interludes: [
      "Imagine you're releasing tension, releasing stress, releasing worry.",
      "Feel the tension melting away with every release.",
      "Let each exhale be soft and unhurried.",
      "Release everything you need to let go of.",
      "With every breath out, imagine letting go of something heavy.",
      "Feel your jaw relax, your forehead smooth.",
      "You're creating space inside yourself.",
      "Let the release feel satisfying, like setting down something heavy.",
      "Your body already knows how to let go. Trust it.",
    ],
    outro: [
      s("Wonderful. After this practice, take some gentle, normal breaths."),
      s("Feel the calm settling into your body."),
      s("You've completed your Lion's Breath session."),
    ],
  },
  {
    name: "Extended Exhale",
    description: "Longer exhales activate the parasympathetic nervous system for deep relaxation.",
    intro: [
      s("Welcome to extended exhale breathing, a deeply relaxing technique."),
      s("Find a comfortable position, sitting or lying down."),
      s("This practice uses a longer exhale than inhale, which naturally calms your nervous system."),
      p(3000),
    ],
    cycle: [
      INHALE, c(1, 3),
      EXHALE, c(1, 6),
    ],
    interludes: [
      "Feel your body relax as you extend the exhale.",
      "As you exhale, let your shoulders drop and let your jaw relax.",
      "Each exhale deepens your relaxation.",
      "You're doing beautifully.",
      "Sink a little deeper with every breath.",
      "The longer exhale is telling your nervous system it's safe to rest.",
      "Let gravity do the work. Just melt.",
      "Notice how much calmer you feel already.",
      "Every breath is a wave of relaxation through your body.",
      "You're worth this time. Let yourself have it fully.",
    ],
    outro: [
      s("Wonderful work."),
      s("When you're ready, take normal breaths and rest in this peaceful state."),
    ],
  },
];

// Nine distinct Deeper Session guides, one per stored session. Each is built
// to the session's full stored duration via buildTimedSegments — previously
// these were fixed ~1-minute scripts that the client looped, so members heard
// the same welcome speech restart every minute. Cycles include a quiet
// breathing-space pause so the longer sessions guide continuously without
// feeling crowded.
type SessionGuide = Omit<TimedBreathwork, "name" | "description">;

const DEEPER_SESSION_GUIDES: SessionGuide[] = [
  // 1
  {
    intro: [
      s("Welcome to this guided breathing meditation."),
      s("Find a comfortable position, seated or lying down, wherever feels supportive right now."),
      s("Gently close your eyes, if that feels right, and take a moment to arrive in this space."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 4), HOLD, c(1, 4), EXHALE, c(1, 6), p(3000)],
    interludes: [
      "Feel your shoulders soften with each exhale.",
      "With each breath, allow yourself to sink a little deeper into calm.",
      "There is nowhere else you need to be, nothing else you need to do, just this breath.",
      "Let your thoughts pass like clouds, and come back to the rhythm.",
      "Notice the stillness growing inside you.",
      "You're doing something truly beautiful for yourself right now.",
      "Let your whole body feel supported and held.",
      "Each cycle is a gentle wave, washing calm through every part of you.",
    ],
    outro: [
      s("Continue resting in this peaceful rhythm for as long as you'd like."),
      s("You are safe. You are supported. You are exactly where you need to be."),
    ],
  },
  // 2
  {
    intro: [
      s("Welcome back to your practice."),
      s("Settle into a position that feels easy for your body, and let your eyes soften or close."),
      s("We'll begin with a slow breath in through the nose."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 5), EXHALE, c(1, 5), p(3000)],
    interludes: [
      "Notice the quiet pause between each breath.",
      "Let your jaw unclench, let your hands rest open.",
      "Each breath is an invitation to release a little more.",
      "There's nothing to fix here, only this rhythm, breath after breath.",
      "Feel the weight of your body being fully supported.",
      "Every exhale is a gentle letting go.",
      "You are giving yourself the gift of stillness.",
      "Let this rhythm carry you, like floating on calm water.",
    ],
    outro: [
      s("Stay here as long as feels good, returning to this pace whenever your mind wanders."),
    ],
  },
  // 3
  {
    intro: [
      s("Welcome. Let's spend this time together, slowing down."),
      s("Find stillness in your body, and let your breath lead the way."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 4), HOLD, c(1, 5), EXHALE, c(1, 7), p(3000)],
    interludes: [
      "Feel the natural pause after each release.",
      "Let go of anything you've been holding onto today.",
      "Your body already knows how to do this. Just let it happen.",
      "Notice how each hold creates a moment of perfect stillness.",
      "You are safe in this space.",
      "Let the rhythm become effortless, like breathing in your sleep.",
      "Feel gratitude for this moment you've given yourself.",
      "The world can wait. Right now, there is only the breath.",
    ],
    outro: [
      s("Continue at this gentle pace, allowing the quiet to settle in around you."),
    ],
  },
  // 4
  {
    intro: [
      s("Welcome to this space of rest."),
      s("Let your body be heavy, supported by whatever is beneath you."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 4), EXHALE, c(1, 4), p(3000)],
    interludes: [
      "A simple, even breath, in and out.",
      "With every exhale, let a little more tension melt away.",
      "Nothing to achieve here, only presence.",
      "Let your body feel heavier with each breath.",
      "This is your time. You earned it.",
      "Feel the calm spreading from your center outward.",
      "Simply be here, breath after gentle breath.",
      "You are exactly where you need to be.",
    ],
    outro: [
      s("Let this rhythm carry you, breath by breath, for as long as you need."),
    ],
  },
  // 5
  {
    intro: [
      s("Welcome. Take a moment to notice how you're feeling right now, without judgment."),
      s("When you're ready, let's begin to slow the breath together."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 5), HOLD, c(1, 3), EXHALE, c(1, 6), p(3000)],
    interludes: [
      "Feel your chest and belly rise and fall naturally.",
      "Each cycle brings you further into stillness.",
      "You don't have to do anything else right now. Just breathe.",
      "Your breath is your anchor. Come back to it whenever your mind wanders.",
      "Notice how much softer your body feels now.",
      "This practice is building resilience, breath by breath.",
      "Let every inhale fill you with fresh energy.",
      "And every exhale release what no longer serves you.",
    ],
    outro: [
      s("Stay with this rhythm, resting in the calm it creates."),
    ],
  },
  // 6
  {
    intro: [
      s("Welcome to this quiet moment."),
      s("Let your shoulders drop away from your ears, and soften your face."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 4), EXHALE, c(1, 8), p(3000)],
    interludes: [
      "Notice how much longer the exhale is. That's intentional. It tells your body it's safe to relax.",
      "Let each breath wash a little more calm through your body.",
      "There's no rush here, only this slow unwinding.",
      "Your nervous system is responding to this long, slow exhale.",
      "Feel yourself becoming softer, lighter, calmer.",
      "This is deep relaxation happening in real time.",
      "Let yourself receive this peace fully.",
      "You're doing something so good for yourself right now.",
    ],
    outro: [
      s("Continue breathing this way for as long as feels good."),
    ],
  },
  // 7
  {
    intro: [
      s("Welcome. Let's take this time to simply be."),
      s("Find a position where your body feels supported and at ease."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 4), HOLD, c(1, 4), EXHALE, c(1, 4), HOLD, c(1, 4), p(3000)],
    interludes: [
      "This even, steady rhythm helps settle a busy mind.",
      "Each pause is a small rest within the breath itself.",
      "Stay easy and unhurried within the square of the breath.",
      "Four equal sides, like a perfect square of calm.",
      "Feel the symmetry settling your thoughts.",
      "You're building a container of peace, breath by breath.",
      "Let the holds be moments of pure stillness.",
      "This is your meditation. This is your time.",
    ],
    outro: [
      s("Continue this gentle square of breath, in your own time."),
    ],
  },
  // 8
  {
    intro: [
      s("Welcome to your practice today."),
      s("Let your attention come fully into your body, right here, right now."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 6), EXHALE, c(1, 6), p(3000)],
    interludes: [
      "An easy, balanced breath, equal in and equal out.",
      "Let your thoughts drift by like clouds, without needing to follow them.",
      "Simply return to the breath, again and again.",
      "This longer count gives your body time to truly settle.",
      "Feel the rhythm becoming as natural as your heartbeat.",
      "You are creating deep calm with every cycle.",
      "Let your whole being rest in this steady flow.",
      "There's nowhere else you need to be. Just here. Just breathing.",
    ],
    outro: [
      s("Rest here in this steady, peaceful rhythm."),
    ],
  },
  // 9
  {
    intro: [
      s("Welcome. This is your time to slow down completely."),
      s("Let your whole body soften into stillness."),
      p(4000),
    ],
    cycle: [INHALE, c(1, 4), HOLD, c(1, 6), EXHALE, c(1, 8), p(3000)],
    interludes: [
      "Feel the calm that builds with every cycle.",
      "There's nowhere to be but here.",
      "Let the breath hold you, cycle after cycle.",
      "The long hold is where the magic happens. Sink into it.",
      "Feel yourself dissolving into pure stillness.",
      "Your body is deeply grateful for this practice.",
      "Each breath cycle is a gift to your nervous system.",
      "Rest in the rhythm. Let it carry everything.",
    ],
    outro: [
      s("Let this rhythm hold you, breath after breath, for as long as you'd like."),
    ],
  },
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
    const dayOfWeek = etDayOfWeek();
    const breathworkIndex = dayOfWeek % BREATHWORK_TYPES.length;
    const todayBreathwork = BREATHWORK_TYPES[breathworkIndex];
    const bgSound = BACKGROUND_SOUNDS[dayOfWeek];

    res.json({
      title: todayBreathwork.name,
      description: todayBreathwork.description,
      script: segmentsToDisplayText([...todayBreathwork.intro, ...todayBreathwork.cycle, ...todayBreathwork.outro]),
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
  const dayOfWeek = etDayOfWeek();
  const cacheKey = `v${CACHE_VERSION}-day-${dayOfWeek}`;

  if (ttsCache.has(cacheKey)) {
    return ttsCache.get(cacheKey)!;
  }

  const breathworkIndex = dayOfWeek % BREATHWORK_TYPES.length;
  const todayBreathwork = BREATHWORK_TYPES[breathworkIndex];

  console.log(`[BREATHWORK] Building TTS for ${todayBreathwork.name}...`);
  // Trailing quiet after the outro gives the client room to fade the music
  // out instead of stopping it dead on the guide's last word.
  const buffer = await buildScriptAudio([
    ...buildTimedSegments(todayBreathwork, DAILY_TARGET_SECONDS - 12),
    p(12000),
  ]);
  ttsCache.set(cacheKey, buffer);
  console.log(`[BREATHWORK] Built ${buffer.length} bytes of TTS audio`);
  return buffer;
}

// Get daily breathwork audio (female voice guiding through today's breathing)
router.get("/audio/daily", async (req, res): Promise<any> => {
  try {
    if (!isTtsConfigured()) {
      console.warn("[BREATHWORK] No OpenAI API key configured, returning background sound only");
      const dayOfWeek = etDayOfWeek();
      const bgSound = BACKGROUND_SOUNDS[dayOfWeek];
      return res.redirect(bgSound.url);
    }

    try {
      const audioBuffer = await generateDailyTTS();
      sendAudioBuffer(req, res, audioBuffer);
    } catch (ttsErr) {
      console.error("[BREATHWORK] TTS generation failed, falling back to background sound:", ttsErr);
      const dayOfWeek = etDayOfWeek();
      const bgSound = BACKGROUND_SOUNDS[dayOfWeek];
      res.redirect(bgSound.url);
    }
  } catch (err) {
    console.error("[BREATHWORK] Error getting daily audio:", err);
    res.status(500).json({ error: "Failed to generate audio" });
  }
});

// Generate (and cache) the guide-voice track for a specific Deeper Session,
// built out to the session's full stored duration so the client never needs
// to loop the voice track.
const sessionGuideCache = new Map<string, Buffer>();

// Every Deeper Session closes the same way: the guide winds the practice
// down, then the track holds ~45s of quiet so the music can breathe and
// fade out instead of cutting off mid-note the moment the voice stops.
const SESSION_WRAP_UP: ScriptSegment[] = [
  s("Our time together is coming to a close."),
  s("Take one final, slow, deep breath in."),
  p(4000),
  s("And let it go."),
  p(4000),
  s("When you're ready, gently return to your day, carrying this calm with you."),
];
const WIND_DOWN_RESERVED_SECONDS = 75; // wrap-up speech + trailing quiet

async function generateSessionGuideTTS(guideIndex: number, durationMinutes: number): Promise<Buffer> {
  const cacheKey = `v${CACHE_VERSION}-${guideIndex}-${durationMinutes}`;
  if (sessionGuideCache.has(cacheKey)) return sessionGuideCache.get(cacheKey)!;

  console.log(`[BREATHWORK] Building Deeper Session guide voice #${guideIndex} (${durationMinutes} min)...`);
  const guide = DEEPER_SESSION_GUIDES[guideIndex];
  const segments = [
    ...buildTimedSegments(
      { name: "", description: "", ...guide },
      durationMinutes * 60 - WIND_DOWN_RESERVED_SECONDS
    ),
    ...SESSION_WRAP_UP,
    p(45000),
  ];
  const buffer = await buildScriptAudio(segments);
  sessionGuideCache.set(cacheKey, buffer);
  console.log(`[BREATHWORK] Built ${buffer.length} bytes for guide #${guideIndex} (${durationMinutes} min)`);
  return buffer;
}

// Get the guide-voice track to layer over a Deeper Session's looping background music.
// :id is the stored session's database id; each session maps to its own unique script.
router.get("/audio/session-guide/:id", async (req, res): Promise<any> => {
  try {
    if (!isTtsConfigured()) {
      return res.status(404).json({ error: "Voice guidance unavailable" });
    }
    const sessionId = parseInt(req.params.id, 10) || 0;
    const guideIndex = sessionId % DEEPER_SESSION_GUIDES.length;

    const { rows } = await pool.query(
      "SELECT duration_minutes FROM guided_breathwork WHERE id = $1",
      [sessionId]
    );
    const durationMinutes = Math.min(Math.max(Number(rows[0]?.duration_minutes) || 10, 5), 30);

    const audioBuffer = await generateSessionGuideTTS(guideIndex, durationMinutes);
    sendAudioBuffer(req, res, audioBuffer);
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
