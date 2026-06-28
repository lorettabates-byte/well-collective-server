const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = "claude-sonnet-4-6";

export function isAnthropicConfigured(): boolean {
  return !!ANTHROPIC_API_KEY;
}

async function callClaude(prompt: string, maxTokens = 600): Promise<string> {
  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not configured");
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Anthropic API error ${res.status}: ${text}`);
  }

  const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
  const textBlock = data.content.find((block) => block.type === "text");
  if (!textBlock?.text) {
    throw new Error("Anthropic response had no text content");
  }
  return textBlock.text;
}

function extractJson(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("No JSON object found in AI response");
  }
  return JSON.parse(match[0]);
}

export interface GeneratedMotivationBoost {
  title: string;
  body: string;
}

export async function generateMotivationBoost(
  weeklyThemeTitle: string | undefined,
  dailyInspirationTitle: string | undefined
): Promise<GeneratedMotivationBoost> {
  const themeContext = weeklyThemeTitle
    ? `This week's theme for the WELL Collective wellness community is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme set right now.";
  const dailyContext = dailyInspirationTitle
    ? ` Today's daily inspiration is titled "${dailyInspirationTitle}".`
    : "";

  const prompt = `You are writing a short, warm "Motivation Boost" message for the WELL Collective, a women's wellness community app run by Loretta Bates. ${themeContext}${dailyContext}

Write one brand-new motivation boost that complements (does not repeat) the above. It should feel like an encouraging friend, not a generic quote account. Avoid cliches like "you got this."

Respond with ONLY a JSON object, no other text, in this exact shape:
{"title": "a short punchy title, under 8 words", "body": "2-3 warm, specific sentences"}`;

  const text = await callClaude(prompt, 400);
  const parsed = extractJson(text) as GeneratedMotivationBoost;
  if (!parsed.title || !parsed.body) {
    throw new Error("AI motivation boost response missing title/body");
  }
  return parsed;
}

export interface GeneratedRecipe {
  name: string;
  description: string;
  ingredients: string[];
  steps: string[];
  imageCategory: string;
  nutrition: {
    calories: number;
    protein: string;
    carbs: string;
    fat: string;
  };
}

const VALID_IMAGE_CATEGORIES = [
  "salad", "grain_bowl", "smoothie", "smoothie_bowl", "soup", "soup_asian",
  "soup_creamy", "soup_brothy", "pasta", "noodles_asian", "chicken", "fish",
  "salmon", "shrimp", "sushi", "oatmeal", "chia_pudding", "overnight_oats",
  "toast", "avocado_toast", "wrap", "rice", "stir_fry", "roasted_vegetables",
  "curry", "tacos", "burrito_bowl", "sandwich", "fruit", "baked", "dessert",
  "flatbread", "energy_balls", "stuffed_vegetables", "lentil", "mediterranean",
  "general_healthy",
];

export async function generateRecipe(
  weeklyThemeTitle: string | undefined,
  recentRecipes: { name: string; imageCategory?: string }[]
): Promise<GeneratedRecipe> {
  const themeContext = weeklyThemeTitle
    ? `This week's wellness theme is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme right now, so keep it generally nourishing and approachable.";

  const recentList = recentRecipes
    .map((r) => `"${r.name}"${r.imageCategory ? ` (${r.imageCategory})` : ""}`)
    .join(", ");
  const avoidContext = recentList
    ? ` Recently served, in order from most recent: ${recentList}. Pick something clearly different from ALL of these — a different dish category, different main ingredient, and a different meal type (don't default to another breakfast/oatmeal/porridge dish or another soup just because recent ones used those).`
    : "";

  const prompt = `You are writing a simple, healthy recipe for the WELL Collective, a women's wellness community app. ${themeContext}${avoidContext}

Write one recipe that ties into that theme (e.g. comforting, energizing, calming, restorative — whatever fits). Keep it realistic for a home cook: 5-8 ingredients, 4-6 short steps. Favor whole foods (vegetables, whole grains, legumes, lean protein, fruit) over the same handful of breakfast staples — across a week, recipes should span breakfast, lunch, dinner, and snacks, not cluster around one meal type.

You must also pick the ONE imageCategory that best matches the finished dish. Choose from EXACTLY one of these:
${VALID_IMAGE_CATEGORIES.join(", ")}

Pick the category that most closely matches what the final plated dish looks like — be as specific as possible (e.g. a salmon dish = "salmon" not "fish", overnight oats = "overnight_oats" not "oatmeal", a Greek/Mediterranean dish = "mediterranean").

For nutrition, do not guess a plausible-sounding total. Work it out ingredient by ingredient: for each ingredient in your list, recall its standard USDA nutrition value for the exact quantity you specified (e.g. "1 cup cooked quinoa" ≈ 222 kcal / 8g protein / 39g carbs / 4g fat), then add them all up for the per-serving totals. Show this reasoning to yourself before answering, but only output the final JSON.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"name": "recipe name", "description": "1 short sentence on why it fits this week", "ingredients": ["...", "..."], "steps": ["...", "..."], "imageCategory": "one_of_the_categories", "nutrition": {"calories": 350, "protein": "20g", "carbs": "30g", "fat": "12g"}}`;

  const text = await callClaude(prompt, 800);
  const parsed = extractJson(text) as GeneratedRecipe;
  if (!parsed.name || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) {
    throw new Error("AI recipe response missing required fields");
  }
  if (!parsed.imageCategory || !VALID_IMAGE_CATEGORIES.includes(parsed.imageCategory)) {
    parsed.imageCategory = "general_healthy";
  }
  if (!parsed.nutrition || typeof parsed.nutrition.calories !== "number") {
    parsed.nutrition = { calories: 0, protein: "—", carbs: "—", fat: "—" };
  }
  return parsed;
}

export interface GeneratedDailyInspiration {
  title: string;
  body: string;
}

export async function generateDailyInspiration(
  weeklyThemeTitle: string | undefined,
  avoidTitle?: string
): Promise<GeneratedDailyInspiration> {
  const themeContext = weeklyThemeTitle
    ? `This week's theme for the WELL Collective wellness community is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme set right now, so keep it generally uplifting.";
  const avoidContext = avoidTitle
    ? ` Do not repeat or closely resemble yesterday's daily inspiration, titled "${avoidTitle}" — write something distinct.`
    : "";

  const prompt = `You are writing today's "Daily Inspiration" message for the WELL Collective, a women's wellness community app run by Loretta Bates. ${themeContext}${avoidContext}

Write one short daily inspiration message that ties into that theme. Warm, grounded, and specific — not a generic quote.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"title": "a short title, under 8 words", "body": "2-3 warm, specific sentences"}`;

  const text = await callClaude(prompt, 400);
  const parsed = extractJson(text) as GeneratedDailyInspiration;
  if (!parsed.title || !parsed.body) {
    throw new Error("AI daily inspiration response missing title/body");
  }
  return parsed;
}

export interface GeneratedWeeklyTheme {
  title: string;
  body: string;
}

export async function generateWeeklyTheme(): Promise<GeneratedWeeklyTheme> {
  const prompt = `You are setting this week's wellness theme for the WELL Collective, a women's wellness community app run by Loretta Bates. Pick a single grounded, encouraging theme (e.g. rest, boundaries, gentle consistency, self-compassion, movement, connection) that the rest of the week's content can build on.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"title": "a short theme title, under 6 words", "body": "2-3 sentences introducing the theme for the week"}`;

  const text = await callClaude(prompt, 400);
  const parsed = extractJson(text) as GeneratedWeeklyTheme;
  if (!parsed.title || !parsed.body) {
    throw new Error("AI weekly theme response missing title/body");
  }
  return parsed;
}

export interface GeneratedWellActivity {
  title: string;
  description: string;
}

export async function generateWellActivity(
  weeklyThemeTitle: string | undefined,
  avoidTitle?: string
): Promise<GeneratedWellActivity> {
  const themeContext = weeklyThemeTitle
    ? `This week's theme for the WELL Collective wellness community is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme right now, so keep it generally restorative.";
  const avoidContext = avoidTitle
    ? ` Do not repeat yesterday's activity, "${avoidTitle}" — suggest something clearly different.`
    : "";

  const prompt = `You are suggesting today's "WELL Activity" — a short mental-health or self-care activity — for the WELL Collective, a women's wellness community app run by Loretta Bates. ${themeContext}${avoidContext}

Suggest one simple, doable-today activity that ties into that theme (e.g. take a bath, call a friend, write three things you're grateful for, take a 10-minute walk without your phone). Keep it concrete and achievable in one sitting.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"title": "a short activity title, under 8 words", "description": "1 short sentence describing it"}`;

  const text = await callClaude(prompt, 300);
  const parsed = extractJson(text) as GeneratedWellActivity;
  if (!parsed.title || !parsed.description) {
    throw new Error("AI WELL activity response missing title/description");
  }
  return parsed;
}

export async function generateNutritionTip(): Promise<string> {
  const prompt = `Write one short, practical nutrition tip of the day (1-2 sentences, under 200 characters) for the WELL Collective women's wellness community. Make it specific and actionable, not generic.

Respond with ONLY the tip text, no quotes, no JSON, no extra commentary.`;

  const text = await callClaude(prompt, 150);
  return text.trim();
}
