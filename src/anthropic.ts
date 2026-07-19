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

  const prompt = `You are writing a short, warm "Motivation Boost" message for the WELL Collective, a wellness community app run by Loretta Bates. The community is predominantly women, but not exclusively — use gender-neutral language throughout (e.g. "you," "someone," "they/them"); never assume the reader is a woman or use "she"/"her"/"woman." ${themeContext}${dailyContext}

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
  // One entry per ingredient, broken out as a USDA-FoodData-Central search
  // query plus an estimated gram weight — lets the server look up real
  // measured nutrition per ingredient instead of trusting the holistic
  // `nutrition` guess above, which only exists as a fallback if that lookup
  // is unavailable or a particular ingredient doesn't resolve.
  nutritionLookup: { foodQuery: string; grams: number }[];
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

// Soft "try to be different" wording wasn't enough — soup and oatmeal/
// porridge kept recurring multiple times a week regardless. These are
// hard-capped at once per rolling 7 days: once either group has appeared,
// it's removed entirely from the category list the AI is even allowed to
// choose from, not just discouraged.
const SOUP_CATEGORIES = ["soup", "soup_asian", "soup_creamy", "soup_brothy"];
const PORRIDGE_CATEGORIES = ["oatmeal", "overnight_oats", "chia_pudding"];

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
    ? ` Recently served, in order from most recent: ${recentList}. Pick something clearly different from ALL of these — a different dish category, different main ingredient, and a different meal type.`
    : "";

  const recentCategories = new Set(recentRecipes.map((r) => r.imageCategory).filter((c): c is string => !!c));
  const blockedCategories = new Set<string>();
  const blockedGroupNames: string[] = [];
  if (SOUP_CATEGORIES.some((c) => recentCategories.has(c))) {
    SOUP_CATEGORIES.forEach((c) => blockedCategories.add(c));
    blockedGroupNames.push("soup/stew/chili/chowder");
  }
  if (PORRIDGE_CATEGORIES.some((c) => recentCategories.has(c))) {
    PORRIDGE_CATEGORIES.forEach((c) => blockedCategories.add(c));
    blockedGroupNames.push("oatmeal/porridge/overnight oats/chia pudding");
  }
  const hardLimitContext = blockedGroupNames.length > 0
    ? ` HARD RULE: ${blockedGroupNames.join(" and ")} ${blockedGroupNames.length > 1 ? "have" : "has"} already been served once in the last 7 days, which is the cap — pick a completely different kind of dish, not another one.`
    : "";
  const allowedCategories = VALID_IMAGE_CATEGORIES.filter((c) => !blockedCategories.has(c));

  const prompt = `You are writing a simple, healthy recipe for the WELL Collective, a wellness community app (predominantly women, but not exclusively — keep any commentary gender-neutral). ${themeContext}${avoidContext}${hardLimitContext}

Write one recipe that ties into that theme (e.g. comforting, energizing, calming, restorative — whatever fits). Keep it realistic for a home cook: 5-8 ingredients, 4-6 short steps. Favor whole foods (vegetables, whole grains, legumes, lean protein, fruit) over the same handful of breakfast staples — across a week, recipes should span breakfast, lunch, dinner, and snacks, not cluster around one meal type.

You must also pick the ONE imageCategory that best matches the finished dish. Choose from EXACTLY one of these:
${allowedCategories.join(", ")}

Pick the category that most closely matches what the final plated dish looks like — be as specific as possible (e.g. a salmon dish = "salmon" not "fish", a Greek/Mediterranean dish = "mediterranean").

You must also provide a nutritionLookup array — one entry per ingredient in your ingredients list, in the same order — with a USDA FoodData Central search query for that food and your best estimate of its weight in grams for the quantity you specified (e.g. "1 cup cooked quinoa" ≈ 185g). This is the data the server will use to look up real measured nutrition, so it matters more than the nutrition field below.

For foodQuery, use USDA's own naming convention as closely as you can recall it, not a casual ingredient name — generic terms like "oats" or "chicken breast" often match the wrong entry (a branded product, an oil, a prepared dish) because FDC's search is plain relevance ranking, not smart disambiguation. Be specific and use the USDA style: "Cereals, oats, regular and quick, unenriched, dry" not "oats"; "Chicken, broilers or fryers, breast, meat only, raw" not "chicken breast"; "Avocados, raw, California" not "avocado"; "Seeds, sesame butter, tahini" not "tahini".

Also provide a fallback nutrition total (only used if the lookup above is unavailable): work it out ingredient by ingredient using standard USDA values for each quantity, then sum.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"name": "recipe name", "description": "1 short sentence on why it fits this week", "ingredients": ["...", "..."], "steps": ["...", "..."], "imageCategory": "one_of_the_categories", "nutritionLookup": [{"foodQuery": "cooked quinoa", "grams": 185}, {"foodQuery": "tahini", "grams": 30}], "nutrition": {"calories": 350, "protein": "20g", "carbs": "30g", "fat": "12g"}}`;

  const text = await callClaude(prompt, 1100);
  const parsed = extractJson(text) as GeneratedRecipe;
  if (!parsed.name || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) {
    throw new Error("AI recipe response missing required fields");
  }
  if (!parsed.imageCategory || !allowedCategories.includes(parsed.imageCategory)) {
    // Either an invalid category, or the model ignored the hard rule above
    // and picked a blocked one anyway — fall back rather than compound a
    // soup/porridge repeat with a mismatched photo on top of it.
    parsed.imageCategory = "general_healthy";
  }
  if (!parsed.nutrition || typeof parsed.nutrition.calories !== "number") {
    parsed.nutrition = { calories: 0, protein: "—", carbs: "—", fat: "—" };
  }
  if (!Array.isArray(parsed.nutritionLookup)) {
    parsed.nutritionLookup = [];
  }
  return parsed;
}

// For recipes generated before nutritionLookup existed — breaks an existing
// ingredient list into the same {foodQuery, grams} shape so old recipes can
// be backfilled with real USDA nutrition instead of staying on whatever
// guess (or nothing) they were originally stored with.
export async function parseIngredientsForNutritionLookup(
  ingredients: string[]
): Promise<{ foodQuery: string; grams: number }[]> {
  const prompt = `For each of these recipe ingredients, give a USDA FoodData Central search query and your best estimate of its weight in grams for the quantity given.

For foodQuery, use USDA's own naming convention as closely as you can recall it, not a casual ingredient name — generic terms like "oats" or "chicken breast" often match the wrong entry (a branded product, an oil, a prepared dish) because FDC's search is plain relevance ranking, not smart disambiguation. Be specific and use the USDA style: "Cereals, oats, regular and quick, unenriched, dry" not "oats"; "Chicken, broilers or fryers, breast, meat only, raw" not "chicken breast"; "Avocados, raw, California" not "avocado"; "Seeds, sesame butter, tahini" not "tahini".

Ingredients:
${ingredients.map((i, idx) => `${idx + 1}. ${i}`).join("\n")}

Respond with ONLY a JSON array, no other text, one entry per ingredient in the same order, in this exact shape:
[{"foodQuery": "Quinoa, cooked", "grams": 185}, {"foodQuery": "Seeds, sesame butter, tahini", "grams": 30}]`;

  const text = await callClaude(prompt, 600);
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error("No JSON array found in ingredient parsing response");
  }
  const parsed = JSON.parse(match[0]) as { foodQuery: string; grams: number }[];
  if (!Array.isArray(parsed)) {
    throw new Error("Ingredient parsing response was not an array");
  }
  return parsed;
}

// Breaks a member's freeform meal description ("grilled chicken breast, brown
// rice, steamed broccoli") into the same {foodQuery, grams} shape used for
// recipes, so the calorie estimator can look up real USDA nutrition per food
// item instead of guessing calories for the meal as a whole.
export async function parseMealDescriptionForNutritionLookup(
  description: string
): Promise<{ label: string; foodQuery: string; grams: number }[]> {
  const prompt = `A member of a wellness app described a meal they ate. Break it into individual food items, and for each one give a short display label, a USDA FoodData Central search query, and your best estimate of its weight in grams for the portion they described.

For label, use a short human-friendly name including the amount they stated (e.g. "2 eggs", "10oz steak", "orange juice").

For foodQuery, use USDA's own naming convention as closely as you can recall it, not a casual food name — generic terms like "oats" or "chicken breast" often match the wrong entry (a branded product, an oil, a prepared dish) because FDC's search is plain relevance ranking, not smart disambiguation. Be specific and use the USDA style: "Cereals, oats, regular and quick, unenriched, dry" not "oats"; "Chicken, broilers or fryers, breast, meat only, raw" not "chicken breast"; "Avocados, raw, California" not "avocado".

If a portion size is stated (e.g. "large", "2 cups", "10oz", "2 servings"), use it to inform the gram estimate. If nothing is stated, assume a typical single-adult portion.

Meal description: "${description}"

Respond with ONLY a JSON array, no other text, one entry per distinct food item, in this exact shape:
[{"label": "grilled chicken breast", "foodQuery": "Chicken, broilers or fryers, breast, meat only, raw", "grams": 170}, {"label": "brown rice", "foodQuery": "Rice, brown, long-grain, cooked", "grams": 195}]`;

  const text = await callClaude(prompt, 800);
  const match = text.match(/\[[\s\S]*\]/);
  if (!match) {
    throw new Error("No JSON array found in meal parsing response");
  }
  const parsed = JSON.parse(match[0]) as { label?: string; foodQuery: string; grams: number }[];
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error("Meal parsing response was not a usable array");
  }
  return parsed.map((item) => ({ ...item, label: item.label || item.foodQuery }));
}

export interface GeneratedDailyInspiration {
  title: string;
  body: string;
}

export async function generateDailyInspiration(
  weeklyThemeTitle: string | undefined,
  recentTitles: string[] = []
): Promise<GeneratedDailyInspiration> {
  const themeContext = weeklyThemeTitle
    ? `This week's theme for the WELL Collective wellness community is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme set right now, so keep it generally uplifting.";
  const avoidContext = recentTitles.length > 0
    ? ` Recent daily inspirations, most recent first: ${recentTitles.map((t) => `"${t}"`).join(", ")}. Do not repeat or closely resemble ANY of these — write something distinct from all of them, not just the most recent one.`
    : "";

  const prompt = `You are writing today's "Daily Inspiration" message for the WELL Collective, a wellness community app run by Loretta Bates. The community is predominantly women, but not exclusively — use gender-neutral language throughout (e.g. "you," "someone," "they/them"); never assume the reader is a woman or use "she"/"her"/"woman." ${themeContext}${avoidContext}

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

export async function generateWeeklyTheme(recentThemes: string[] = []): Promise<GeneratedWeeklyTheme> {
  const avoidContext = recentThemes.length > 0
    ? ` Recent themes, most recent first: ${recentThemes.map((t) => `"${t}"`).join(", ")}. Pick something clearly different from ALL of these — not just a different word for the same idea (e.g. "Rest" and "Slowing Down" are too similar to use back to back).`
    : "";

  const prompt = `You are setting this week's wellness theme for the WELL Collective, a wellness community app run by Loretta Bates. The community is predominantly women, but not exclusively — use gender-neutral language throughout (e.g. "you," "someone," "they/them"); never assume the reader is a woman or use "she"/"her"/"woman." Pick a single grounded, encouraging theme (e.g. rest, boundaries, gentle consistency, self-compassion, movement, connection, gratitude, joy, resilience) that the rest of the week's content can build on.${avoidContext}

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
  recentTitles: string[] = []
): Promise<GeneratedWellActivity> {
  const themeContext = weeklyThemeTitle
    ? `This week's theme for the WELL Collective wellness community is "${weeklyThemeTitle}".`
    : "There's no specific weekly theme right now, so keep it generally restorative.";
  const avoidContext = recentTitles.length > 0
    ? ` Recent WELL activities, most recent first: ${recentTitles.map((t) => `"${t}"`).join(", ")}. Do not repeat or closely resemble ANY of these — suggest something clearly different from all of them.`
    : "";

  const prompt = `You are suggesting today's "WELL Activity" — a short mental-health or self-care activity — for the WELL Collective, a wellness community app run by Loretta Bates. The community is predominantly women, but not exclusively — use gender-neutral language throughout (e.g. "you," "someone," "they/them"); never assume the reader is a woman or use "she"/"her"/"woman." ${themeContext}${avoidContext}

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

export interface GeneratedSimpleRecipe {
  name: string;
  description: string;
  ingredients: string[];
  steps: string[];
  image?: string;
}

// Used by the admin "suggest a food type" recipe generator — a simpler,
// on-demand counterpart to generateRecipe() above (which is for the
// automated daily schedule and needs the fuller imageCategory/nutrition
// shape). This just needs name/description/ingredients/steps to populate
// the admin form fields.
export async function generateRecipeFromSuggestion(suggestion: string): Promise<GeneratedSimpleRecipe> {
  const prompt = `Generate a healthy, realistic recipe for the WELL Collective wellness community based on this suggestion: "${suggestion}".

Keep it realistic for a home cook: 5-8 ingredients, 4-6 short steps.

Also provide a working Unsplash image URL that matches this recipe. Use format: https://images.unsplash.com/photo-<id>?w=500&h=300&fit=crop or a direct search-based Unsplash URL.

Respond with ONLY a JSON object, no other text, in this exact shape:
{"name": "recipe name", "description": "1-2 short sentences", "ingredients": ["...", "..."], "steps": ["...", "..."], "image": "https://..."}`;

  const text = await callClaude(prompt, 1000);
  const parsed = extractJson(text) as GeneratedSimpleRecipe;
  if (!parsed.name || !Array.isArray(parsed.ingredients) || !Array.isArray(parsed.steps)) {
    throw new Error("AI recipe response missing required fields");
  }

  // If Claude didn't provide a valid image URL, use a fallback
  if (!parsed.image || !parsed.image.startsWith("http")) {
    parsed.image = `https://images.unsplash.com/photo-1495521821757-a1efb6729352?w=500&h=300&fit=crop`;
  }

  return parsed;
}

export async function generateNutritionTip(): Promise<string> {
  const prompt = `Write one short, practical nutrition tip of the day (1-2 sentences, under 200 characters) for the WELL Collective wellness community (predominantly women, but not exclusively — keep it gender-neutral). Make it specific and actionable, not generic.

Respond with ONLY the tip text, no quotes, no JSON, no extra commentary.`;

  const text = await callClaude(prompt, 150);
  return text.trim();
}
