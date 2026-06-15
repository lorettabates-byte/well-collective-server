const WC_STORE_URL = process.env.WC_STORE_URL;
const WC_CONSUMER_KEY = process.env.WC_CONSUMER_KEY;
const WC_CONSUMER_SECRET = process.env.WC_CONSUMER_SECRET;

export function isWooCommerceConfigured(): boolean {
  return !!(WC_STORE_URL && WC_CONSUMER_KEY && WC_CONSUMER_SECRET);
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${WC_CONSUMER_KEY}:${WC_CONSUMER_SECRET}`).toString("base64");
}

export interface WooCouponInput {
  code: string;
  amount: string;
  discount_type: "fixed_cart" | "percent";
  description?: string;
  product_ids?: number[];
  product_categories?: number[];
  usage_limit?: number;
  usage_limit_per_user?: number;
  date_expires?: string;
}

export async function createWooCommerceCoupon(input: WooCouponInput): Promise<{ id: number; code: string }> {
  if (!isWooCommerceConfigured()) {
    throw new Error("WooCommerce credentials not configured");
  }

  const res = await fetch(`${WC_STORE_URL}/wp-json/wc/v3/coupons`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader(),
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WooCommerce API error ${res.status}: ${text}`);
  }

  return (await res.json()) as { id: number; code: string };
}

export interface WooProduct {
  id: number;
  name: string;
}

export async function searchWooCommerceProducts(query: string): Promise<WooProduct[]> {
  if (!isWooCommerceConfigured()) {
    throw new Error("WooCommerce credentials not configured");
  }

  const url = new URL(`${WC_STORE_URL}/wp-json/wc/v3/products`);
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", "10");

  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader() },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WooCommerce API error ${res.status}: ${text}`);
  }

  const products = (await res.json()) as Array<{ id: number; name: string }>;
  return products.map((p) => ({ id: p.id, name: p.name }));
}

export interface WooCategory {
  id: number;
  name: string;
}

export async function searchWooCommerceProductCategories(query: string): Promise<WooCategory[]> {
  if (!isWooCommerceConfigured()) {
    throw new Error("WooCommerce credentials not configured");
  }

  const url = new URL(`${WC_STORE_URL}/wp-json/wc/v3/products/categories`);
  url.searchParams.set("search", query);
  url.searchParams.set("per_page", "10");

  const res = await fetch(url.toString(), {
    headers: { Authorization: authHeader() },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`WooCommerce API error ${res.status}: ${text}`);
  }

  const categories = (await res.json()) as Array<{ id: number; name: string }>;
  return categories.map((c) => ({ id: c.id, name: c.name }));
}
