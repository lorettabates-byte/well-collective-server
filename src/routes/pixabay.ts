import { Router } from "express";
import https from "https";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

// Curated search terms per exercise so auto-find has the best chance of
// returning a relevant Pixabay video when no URL has been manually saved.
const EXERCISE_SEARCH: Record<string, string> = {
  // Resistance
  "Bodyweight Squats":              "squat fitness exercise workout",
  "Push-Ups (knee or full)":        "push ups exercise workout",
  "Glute Bridges":                  "glute bridge fitness exercise",
  "Walking Lunges":                 "lunges fitness gym exercise",
  "Dumbbell Rows":                  "dumbbell row back exercise",
  "Plank Hold":                     "plank core exercise fitness",
  "Wall Sit":                       "wall sit legs exercise fitness",
  "Standing Calf Raises":           "calf raise legs exercise",
  "Resistance Band Rows":           "resistance band row exercise",
  "Bicycle Crunches":               "bicycle crunch abs exercise",
  "Sumo Squats":                    "sumo squat inner thigh exercise",
  "Reverse Lunges":                 "reverse lunge legs exercise",
  "Tricep Dips":                    "tricep dips chair exercise",
  "Side-Lying Leg Lifts":           "side lying leg lift exercise",
  "Donkey Kicks":                   "donkey kick glute exercise",
  "Dead Bug":                       "dead bug core exercise",
  "Lateral Band Walks":             "resistance band lateral walk exercise",
  "Single-Leg Deadlift":            "single leg deadlift balance exercise",
  "Shoulder Press":                 "dumbbell shoulder press exercise",
  "Dumbbell Bicep Curls":           "dumbbell bicep curl exercise",
  "Superman Hold":                  "superman back extension exercise",
  "Step-Ups":                       "step up exercise fitness",
  "Squat to Overhead Press":        "squat press dumbbell exercise",
  "Renegade Rows":                  "renegade row plank exercise",
  "Hip Thrusts":                    "hip thrust glute exercise",
  "Side Plank":                     "side plank core exercise",
  "Resistance Band Chest Press":    "resistance band chest press exercise",
  "Goblet Squat":                   "goblet squat dumbbell exercise",
  "Tricep Kickbacks":               "tricep kickback dumbbell exercise",
  "Mountain Climbers":              "mountain climbers core cardio exercise",
  // Stretches
  "Standing Forward Fold":          "yoga forward fold stretch",
  "Cat-Cow Stretch":                "yoga cat cow pose stretch",
  "Seated Spinal Twist":            "yoga seated twist stretch",
  "Hip Flexor Lunge Stretch":       "hip flexor stretch yoga",
  "Child's Pose":                   "yoga child pose stretch",
  "Shoulder & Chest Opener":        "chest shoulder stretch yoga",
  "Hamstring Stretch":              "hamstring stretch yoga",
  "Figure-Four Glute Stretch":      "hip figure four stretch yoga",
  "Neck Rolls":                     "neck stretch yoga relaxation",
  "Supine Twist":                   "supine spinal twist yoga stretch",
  "Doorway Chest Stretch":          "chest stretch doorway yoga",
  "Seated Butterfly":               "butterfly pose inner thigh yoga stretch",
  "Thread the Needle":              "thread needle upper back yoga stretch",
  "Low Lunge Quad Stretch":         "low lunge quad stretch yoga",
  "Wide-Leg Seated Fold":           "wide leg seated forward fold yoga",
  "Cow Face Arms":                  "cow face arms shoulder stretch yoga",
  "Standing Quad Stretch":          "standing quad stretch balance",
  "Lying Piriformis Stretch":       "piriformis hip stretch yoga",
  "Doorway Calf Stretch":           "calf stretch wall yoga",
  "Upper Trapezius Stretch":        "neck trapezius stretch yoga",
};

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS exercise_videos (
      exercise_name TEXT PRIMARY KEY,
      video_url     TEXT NOT NULL,
      updated_at    TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function pixabaySearch(term: string, key: string): Promise<string | null> {
  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encodeURIComponent(term)}&per_page=5&safesearch=true`;
  const data = await new Promise<string>((resolve, reject) => {
    https.get(url, (resp) => {
      let body = "";
      resp.on("data", (c) => { body += c; });
      resp.on("end", () => resolve(body));
      resp.on("error", reject);
    }).on("error", reject);
  });
  const json = JSON.parse(data) as {
    hits?: Array<{ videos: { medium?: { url?: string }; small?: { url?: string }; large?: { url?: string } } }>;
  };
  const hit = json.hits?.[0];
  return hit?.videos?.medium?.url || hit?.videos?.small?.url || hit?.videos?.large?.url || null;
}

// Client-facing: return saved video URL for this exercise name.
// Falls back to a Pixabay search (using the curated term) if nothing is saved yet.
router.get("/pixabay/video", async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) return res.status(400).json({ error: "q is required" });

  const key = process.env.PIXABAY_API_KEY;
  if (!key) return res.status(503).json({ error: "Pixabay not configured" });

  try {
    await ensureTable();

    // Check DB cache first
    const { rows } = await pool.query(
      "SELECT video_url FROM exercise_videos WHERE exercise_name = $1",
      [q]
    );
    if (rows[0]?.video_url) return res.json({ url: rows[0].video_url });

    // Auto-search using curated term and cache the result
    const term = EXERCISE_SEARCH[q] ?? q;
    const videoUrl = await pixabaySearch(term, key);

    if (videoUrl) {
      await pool.query(
        "INSERT INTO exercise_videos (exercise_name, video_url) VALUES ($1, $2) ON CONFLICT (exercise_name) DO UPDATE SET video_url = $2, updated_at = NOW()",
        [q, videoUrl]
      );
    }

    res.json({ url: videoUrl });
  } catch (err) {
    console.error("Pixabay video error:", err);
    res.status(500).json({ error: "Failed to fetch video" });
  }
});

// Admin: list all saved exercise video assignments
router.get("/admin/exercise-videos", requireAdmin, async (_req, res) => {
  try {
    await ensureTable();
    const { rows } = await pool.query(
      "SELECT exercise_name, video_url, updated_at FROM exercise_videos ORDER BY exercise_name"
    );
    res.json({ videos: rows });
  } catch (err) {
    console.error("Exercise videos list error:", err);
    res.status(500).json({ error: "Failed to load" });
  }
});

// Admin: save/update a video URL for an exercise
router.put("/admin/exercise-videos", requireAdmin, async (req, res) => {
  const { exerciseName, videoUrl } = req.body as { exerciseName?: string; videoUrl?: string };
  if (!exerciseName || !videoUrl) {
    return res.status(400).json({ error: "exerciseName and videoUrl required" });
  }
  try {
    await ensureTable();
    await pool.query(
      "INSERT INTO exercise_videos (exercise_name, video_url) VALUES ($1, $2) ON CONFLICT (exercise_name) DO UPDATE SET video_url = $2, updated_at = NOW()",
      [exerciseName.trim(), videoUrl.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("Exercise video save error:", err);
    res.status(500).json({ error: "Failed to save" });
  }
});

// Admin: search Pixabay for a given term (preview only — does not save)
router.get("/admin/exercise-videos/search", requireAdmin, async (req, res) => {
  const term = (req.query.term as string | undefined)?.trim();
  if (!term) return res.status(400).json({ error: "term is required" });
  const key = process.env.PIXABAY_API_KEY;
  if (!key) return res.status(503).json({ error: "Pixabay not configured" });
  try {
    const url = await pixabaySearch(term, key);
    res.json({ url });
  } catch (err) {
    console.error("Pixabay search error:", err);
    res.status(500).json({ error: "Search failed" });
  }
});

// Admin: delete a saved assignment (resets to auto-search)
router.delete("/admin/exercise-videos", requireAdmin, async (req, res) => {
  const { exerciseName } = req.body as { exerciseName?: string };
  if (!exerciseName) return res.status(400).json({ error: "exerciseName required" });
  try {
    await pool.query("DELETE FROM exercise_videos WHERE exercise_name = $1", [exerciseName]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Exercise video delete error:", err);
    res.status(500).json({ error: "Failed to delete" });
  }
});

export default router;
