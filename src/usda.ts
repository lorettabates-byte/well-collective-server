// Looks up real per-ingredient nutrition from USDA FoodData Central — a
// free, government-run nutrition database — instead of trusting an LLM's
// freehand guess. The AI still picks each ingredient and estimates its
// gram weight (e.g. "1 cup cooked quinoa" -> 185g), but the actual
// calorie/protein/carb/fat values come from FDC's measured data.
const FDC_API_KEY = process.env.FDC_API_KEY;

export function isUsdaConfigured(): boolean {
  return !!FDC_API_KEY;
}

interface FdcNutrient {
  nutrientId: number;
  value: number;
}

interface FdcFood {
  fdcId: number;
  description: string;
  foodNutrients: FdcNutrient[];
}

// Standard, stable nutrient IDs in FDC's schema (same across all data types).
const NUTRIENT_IDS = {
  calories: 1008, // Energy (kcal)
  protein: 1003,
  carbs: 1005, // Carbohydrate, by difference
  fat: 1004, // Total lipid (fat)
};

// Restricting to these two non-branded data types keeps results in
// per-100g terms consistently — "Branded" foods report per-serving values
// in inconsistent serving sizes, which would throw off the gram-based math.
const DATA_TYPES = "Survey (FNDDS),SR Legacy";

const STOPWORDS = new Set(["raw", "cooked", "fresh", "and", "or", "of", "the", "a", "with"]);

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w));
}

// FDC's plain-text search ranks by general relevance, not "closest canonical
// ingredient" — a query like "avocado" can return "Oil, avocado" or "Avocado
// dressing" ahead of the plain raw food. Scoring a handful of candidates by
// word overlap with the query and picking the best one catches most of
// these mismatches without needing a curated ingredient database.
function pickBestMatch(query: string, candidates: FdcFood[]): FdcFood | null {
  if (candidates.length === 0) return null;
  const queryWords = significantWords(query);
  if (queryWords.length === 0) return candidates[0];

  let best = candidates[0];
  let bestScore = -1;
  for (const candidate of candidates) {
    const descWords = new Set(significantWords(candidate.description));
    const overlap = queryWords.filter((w) => descWords.has(w)).length;
    // Slightly penalize longer descriptions among equal-overlap candidates —
    // they tend to be more specific/compound dishes than the plain ingredient.
    const score = overlap - descWords.size * 0.01;
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

// FDC's API gateway is intermittently flaky — and not just per-request
// independent flakiness; failures cluster in bursts, so the exact same
// query can fail 5 times in a row in one run and succeed instantly in the
// next. This runs in the background (cron/admin tool), so trading latency
// for reliability is the right call — up to 10 attempts with backoff capped
// at 3s, which in testing rides out even multi-second bad windows.
async function searchFood(query: string, attempt = 1): Promise<FdcFood | null> {
  if (!FDC_API_KEY) return null;
  const params = new URLSearchParams({
    api_key: FDC_API_KEY,
    query,
    dataType: DATA_TYPES,
    pageSize: "5",
  });
  const res = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?${params.toString()}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    if (attempt < 10) {
      await new Promise((r) => setTimeout(r, Math.min(400 * attempt, 3000)));
      return searchFood(query, attempt + 1);
    }
    return null;
  }
  const data = (await res.json()) as { foods?: FdcFood[] };
  return pickBestMatch(query, data.foods ?? []);
}

function per100g(food: FdcFood) {
  const get = (id: number) => food.foodNutrients.find((n) => n.nutrientId === id)?.value ?? 0;
  return {
    calories: get(NUTRIENT_IDS.calories),
    protein: get(NUTRIENT_IDS.protein),
    carbs: get(NUTRIENT_IDS.carbs),
    fat: get(NUTRIENT_IDS.fat),
  };
}

export interface NutritionLookupItem {
  foodQuery: string;
  grams: number;
}

export interface ComputedNutrition {
  calories: number;
  protein: string;
  carbs: string;
  fat: string;
  // False if any ingredient couldn't be matched in FDC and was skipped —
  // the totals are then a partial sum, not the full recipe.
  verified: boolean;
}

export async function computeNutritionFromIngredients(
  items: NutritionLookupItem[]
): Promise<ComputedNutrition | null> {
  if (!FDC_API_KEY || items.length === 0) return null;

  // Sequential, not Promise.all — FDC's gateway fails far more often when
  // several requests land on it at the same instant than when they're spaced
  // out by normal network latency, so firing all ingredients at once made
  // the retry logic above need to fight much worse odds.
  const results: ({ calories: number; protein: number; carbs: number; fat: number; grams: number } | null)[] = [];
  for (const item of items) {
    try {
      const food = await searchFood(item.foodQuery);
      results.push(food ? { ...per100g(food), grams: item.grams } : null);
    } catch (err) {
      console.error(`USDA lookup failed for "${item.foodQuery}":`, err);
      results.push(null);
    }
  }

  let calories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;
  let allResolved = true;

  for (const r of results) {
    if (!r) {
      allResolved = false;
      continue;
    }
    const factor = r.grams / 100;
    calories += r.calories * factor;
    protein += r.protein * factor;
    carbs += r.carbs * factor;
    fat += r.fat * factor;
  }

  return {
    calories: Math.round(calories),
    protein: `${Math.round(protein)}g`,
    carbs: `${Math.round(carbs)}g`,
    fat: `${Math.round(fat)}g`,
    verified: allResolved,
  };
}
