import { Router } from "express";
import https from "https";

const router = Router();

// Proxy Pixabay video search so the API key never reaches the client.
// Returns the best available video URL for the given query, or null if none found.
router.get("/pixabay/video", async (req, res) => {
  const q = (req.query.q as string | undefined)?.trim();
  if (!q) return res.status(400).json({ error: "q is required" });

  const key = process.env.PIXABAY_API_KEY;
  if (!key) return res.status(503).json({ error: "Pixabay not configured" });

  const encoded = encodeURIComponent(q);
  const url = `https://pixabay.com/api/videos/?key=${key}&q=${encoded}&per_page=5&safesearch=true`;

  try {
    const data = await new Promise<string>((resolve, reject) => {
      https.get(url, (resp) => {
        let body = "";
        resp.on("data", (chunk) => { body += chunk; });
        resp.on("end", () => resolve(body));
        resp.on("error", reject);
      }).on("error", reject);
    });

    const json = JSON.parse(data) as {
      hits?: Array<{ videos: { medium?: { url?: string }; small?: { url?: string }; large?: { url?: string } } }>;
    };

    const hit = json.hits?.[0];
    const videoUrl = hit?.videos?.medium?.url || hit?.videos?.small?.url || hit?.videos?.large?.url || null;

    res.json({ url: videoUrl });
  } catch (err) {
    console.error("Pixabay video error:", err);
    res.status(500).json({ error: "Failed to fetch video" });
  }
});

export default router;
