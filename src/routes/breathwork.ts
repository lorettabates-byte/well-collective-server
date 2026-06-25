import { Router } from "express";
import { pool } from "../db";

const router = Router();

const BREATHWORK_TYPES = [
  {
    name: "Box Breathing",
    description: "Inhale for 4 counts, hold for 4 counts, exhale for 4 counts, hold for 4 counts. Repeat 5 times.",
    script: "Welcome to today's guided box breathing exercise. Box breathing helps calm your nervous system and improve focus. Let's begin. First, find a comfortable position and close your eyes if you'd like. Take a moment to settle in. Now, we'll start with a normal breath. Then, inhale slowly through your nose for a count of 4: one, two, three, four. Hold that breath for a count of 4: one, two, three, four. Now exhale slowly through your mouth for a count of 4: one, two, three, four. Hold empty for a count of 4: one, two, three, four. Good. Let's continue. Inhale for 4: one, two, three, four. Hold for 4: one, two, three, four. Exhale for 4: one, two, three, four. Hold for 4: one, two, three, four. Continue at your own pace with this rhythm. Inhale, two, three, four. Hold, two, three, four. Exhale, two, three, four. Hold, two, three, four. Beautiful. Keep breathing this way. Each breath bringing you deeper into calm. When you're ready, take three natural breaths and gently open your eyes. You've completed your box breathing exercise.",
  },
  {
    name: "Diaphragmatic Breathing",
    description: "Deep belly breathing to activate your parasympathetic nervous system. Breathe in for 4 counts, out for 6 counts.",
    script: "Welcome to diaphragmatic breathing. This technique helps reduce stress and promotes deep relaxation. Find a comfortable seated or lying position. You can place one hand on your chest and one on your belly. Let's begin. Breathe normally for a moment. Now, as you inhale through your nose, imagine the breath traveling all the way down into your belly, causing it to expand. Count: one, two, three, four. Pause briefly. Now exhale slowly through your mouth for a longer count: one, two, three, four, five, six. Feel your belly fall as you release the breath. Again, inhale through your nose for four: one, two, three, four. And exhale for six: one, two, three, four, five, six. The exhale is longer than the inhale, which signals your body to relax. Continue this pattern. Inhale: one, two, three, four. Exhale: one, two, three, four, five, six. Feel yourself becoming more and more relaxed with each breath. Inhale deeply: one, two, three, four. Exhale slowly: one, two, three, four, five, six. You're doing beautifully. Continue breathing this way, allowing your body to sink deeper into calm with each cycle. When you're ready, take a few natural breaths and gently return to your day.",
  },
  {
    name: "4-7-8 Breathing",
    description: "A calming technique: inhale for 4, hold for 7, exhale for 8. Perfect before sleep.",
    script: "Welcome to the 4-7-8 breathing technique, designed to calm your mind and prepare your body for rest. Find a comfortable position, seated or lying down. Let's begin. Start by exhaling completely through your mouth with a whoosh sound. Now, close your mouth and inhale quietly through your nose for a count of 4: one, two, three, four. Hold that breath for a count of 7: one, two, three, four, five, six, seven. Now exhale completely through your mouth for a count of 8: one, two, three, four, five, six, seven, eight. This completes one cycle. Let's do it again. Inhale through your nose for 4: one, two, three, four. Hold for 7: one, two, three, four, five, six, seven. Exhale for 8: one, two, three, four, five, six, seven, eight. Wonderful. Continue with this rhythm. Inhale: one, two, three, four. Hold: one, two, three, four, five, six, seven. Exhale: one, two, three, four, five, six, seven, eight. Feel the calm washing over you. Inhale: one, two, three, four. Hold: one, two, three, four, five, six, seven. Exhale: one, two, three, four, five, six, seven, eight. Continue several more times at your own pace. This technique is wonderful before bedtime. When you're complete, take normal breaths and allow yourself to rest peacefully.",
  },
  {
    name: "Alternate Nostril Breathing",
    description: "Balance your energy: alternate between breathing through left and right nostrils.",
    script: "Welcome to alternate nostril breathing, a balancing technique that harmonizes your body and mind. Sit comfortably with your spine straight. We'll use a hand position called Vishnu mudra. Fold your index and middle fingers down, leaving your thumb and ring finger extended. Let's begin. Close your right nostril with your thumb and inhale through your left nostril for a count of 4: one, two, three, four. Now release your thumb and close your left nostril with your ring finger. Exhale through your right nostril for 4: one, two, three, four. Inhale through the right nostril for 4: one, two, three, four. Switch again. Close your right nostril and exhale through the left for 4: one, two, three, four. This is one complete cycle. Continue. Inhale left: one, two, three, four. Switch, exhale right: one, two, three, four. Inhale right: one, two, three, four. Switch, exhale left: one, two, three, four. Wonderful. You're balancing your energy with each breath. Keep this rhythm flowing smoothly. Feel yourself becoming more centered and calm. Continue this beautiful practice. When you're ready, return to normal breathing with both nostrils. You've completed your alternate nostril breathing.",
  },
  {
    name: "Coherent Breathing",
    description: "5-second inhale, 5-second exhale. Synchronizes heart rate variability.",
    script: "Welcome to coherent breathing, a gentle technique that brings your body into a state of balance and ease. Find a comfortable position. Let's begin with a few normal breaths to settle in. Now, we'll inhale through your nose for a count of 5: one, two, three, four, five. Then exhale through your mouth for a count of 5: one, two, three, four, five. The breath is equal in and out, creating a beautiful rhythm. Inhale: one, two, three, four, five. Exhale: one, two, three, four, five. This simple pattern has profound effects on your nervous system. Inhale: one, two, three, four, five. Exhale: one, two, three, four, five. Continue at this peaceful pace. Each breath bringing you more into the present moment. Inhale: one, two, three, four, five. Exhale: one, two, three, four, five. Feel your heart rate synchronizing with your breath. You're in perfect coherence. Inhale: one, two, three, four, five. Exhale: one, two, three, four, five. Beautiful work. Continue this rhythm for as long as you'd like. This is your anchor, your place of calm. When you're ready, let your breath return to normal and rest in this peaceful state.",
  },
  {
    name: "Lion's Breath",
    description: "Energizing exhale with open mouth and tongue out. Great for releasing tension.",
    script: "Welcome to Lion's Breath, an energizing technique that helps release tension and invigorate your body. This practice involves a powerful exhale, so make sure you have space to breathe freely. Stand or sit comfortably. Let's begin. Take a deep breath in through your nose. As you prepare for the exhale, open your mouth wide. Now, as you exhale, let out a strong breath through your mouth while extending your tongue down toward your chin. Make a 'ha' sound if you'd like. Exhale completely. Take another breath in through your nose. Prepare yourself. Open your mouth wide and exhale powerfully with your tongue extended. Release all the stale air. Breathe in again. This time, as you exhale, imagine you're releasing all tension, all stress, all worry. Let it go with a powerful breath. Inhale once more. Exhale fully with power and intention. Feel the energy moving through you. One more time. Breathe in deeply. Exhale with force, releasing everything you need to let go of. Wonderful. After this powerful practice, take some gentle, normal breaths. Feel the renewed energy in your body. You've completed your Lion's Breath session.",
  },
  {
    name: "Extended Exhale",
    description: "Longer exhales activate the parasympathetic nervous system for deep relaxation.",
    script: "Welcome to extended exhale breathing, a deeply relaxing technique. Find a comfortable position, sitting or lying down. This practice uses a longer exhale than inhale, which naturally calms your nervous system. Let's begin. Inhale through your nose for a count of 3: one, two, three. Now exhale through your mouth for a count of 6: one, two, three, four, five, six. Feel your body relax as you extend the exhale. Inhale for 3: one, two, three. Exhale for 6: one, two, three, four, five, six. Continue this beautiful rhythm. Inhale: one, two, three. Exhale: one, two, three, four, five, six. As you exhale, let your shoulders drop, let your jaw relax. Inhale: one, two, three. Exhale: one, two, three, four, five, six. Each exhale deepens your relaxation. Inhale: one, two, three. Exhale: one, two, three, four, five, six. You're doing beautifully. Keep breathing this way. Inhale: one, two, three. Exhale: one, two, three, four, five, six. Feel yourself sinking deeper into calm with each breath. Continue this practice, allowing yourself to become more and more relaxed. When you're ready, take normal breaths and rest in this peaceful state.",
  },
];

// Get today's breathwork script (same as the daily well activity)
router.get("/today", async (req, res) => {
  try {
    // Get today's well activity to determine which breathwork script to use
    // For now, we'll just return one based on the day of the week
    const dayOfWeek = new Date().getDay();
    const breathworkIndex = dayOfWeek % BREATHWORK_TYPES.length;
    const todayBreathwork = BREATHWORK_TYPES[breathworkIndex];

    res.json({
      title: todayBreathwork.name,
      description: todayBreathwork.description,
      script: todayBreathwork.script,
      duration: 5,
    });
  } catch (err) {
    console.error("[BREATHWORK] Error getting today's breathwork:", err);
    res.status(500).json({ error: "Failed to get breathwork" });
  }
});

// Get all stored longer breathwork sessions
router.get("/sessions", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, duration_minutes, title, description FROM guided_breathwork ORDER BY duration_minutes, sort_order"
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

export default router;
