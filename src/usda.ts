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

async function searchFood(query: string): Promise<FdcFood | null> {
  if (!FDC_API_KEY) return null;
  const params = new URLSearchParams({
    api_key: FDC_API_KEY,
    query,
    dataType: DATA_TYPES,
    pageSize: "1",
  });
  const res = await fetch(`https://api.nal.usda.gov/fdc/v1/foods/search?${params.toString()}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { foods?: FdcFood[] };
  return data.foods?.[0] ?? null;
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

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const food = await searchFood(item.foodQuery);
        if (!food) return null;
        return { ...per100g(food), grams: item.grams };
      } catch (err) {
        console.error(`USDA lookup failed for "${item.foodQuery}":`, err);
        return null;
      }
    })
  );

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
