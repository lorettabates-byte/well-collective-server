import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";
import { createWooCommerceCoupon, isWooCommerceConfigured, searchWooCommerceProducts } from "../woocommerce";

const router = Router();

interface CouponInput {
  code: string;
  description?: string;
  discount_type: "percentage" | "fixed";
  discount_value: number;
  max_uses?: number;
  expires_at?: string;
}

// Search WooCommerce products by name (admin only)
router.get("/wc-products", requireAdmin, async (req, res) => {
  const { search } = req.query as { search?: string };

  if (!search) {
    return res.status(400).json({ error: "search query required" });
  }

  if (!isWooCommerceConfigured()) {
    return res.status(500).json({ error: "WooCommerce is not configured on the server" });
  }

  try {
    const products = await searchWooCommerceProducts(search);
    res.json({ products });
  } catch (err) {
    console.error("WooCommerce product search error:", err);
    res.status(502).json({ error: "Failed to search products on the store" });
  }
});

// Get all coupons (admin only)
router.get("/", requireAdmin, async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, code, description, discount_type, discount_value, max_uses, used_count, expires_at, created_at
       FROM coupons ORDER BY created_at DESC`
    );
    res.json({ coupons: rows });
  } catch (err) {
    console.error("Fetch coupons error:", err);
    res.status(500).json({ error: "Failed to fetch coupons" });
  }
});

// Create a single coupon (admin only)
router.post("/", requireAdmin, async (req, res) => {
  const { code, description, discount_type, discount_value, max_uses, expires_at } = req.body as CouponInput;

  if (!code || !discount_type || !discount_value) {
    return res.status(400).json({ error: "Code, discount_type, and discount_value required" });
  }

  if (!["percentage", "fixed"].includes(discount_type)) {
    return res.status(400).json({ error: "discount_type must be 'percentage' or 'fixed'" });
  }

  try {
    const { rows } = await pool.query(
      `INSERT INTO coupons (code, description, discount_type, discount_value, max_uses, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, code, description, discount_type, discount_value, max_uses, expires_at`,
      [code.toUpperCase(), description || null, discount_type, discount_value, max_uses || null, expires_at || null]
    );

    res.status(201).json({ coupon: rows[0] });
  } catch (err: unknown) {
    if ((err as any)?.code === "23505") {
      return res.status(409).json({ error: `Coupon code '${code}' already exists` });
    }
    console.error("Create coupon error:", err);
    res.status(500).json({ error: "Failed to create coupon" });
  }
});

// Bulk import coupons (admin only)
router.post("/bulk", requireAdmin, async (req, res) => {
  const { coupons } = req.body as { coupons: CouponInput[] };

  if (!Array.isArray(coupons) || coupons.length === 0) {
    return res.status(400).json({ error: "Expected array of coupons" });
  }

  try {
    let created = 0;
    let failed = 0;

    for (const coupon of coupons) {
      if (!coupon.code || !coupon.discount_type || coupon.discount_value === undefined) {
        failed++;
        continue;
      }

      try {
        await pool.query(
          `INSERT INTO coupons (code, description, discount_type, discount_value, max_uses, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (code) DO NOTHING`,
          [
            coupon.code.toUpperCase(),
            coupon.description || null,
            coupon.discount_type,
            coupon.discount_value,
            coupon.max_uses || null,
            coupon.expires_at || null,
          ]
        );
        created++;
      } catch {
        failed++;
      }
    }

    res.status(201).json({ imported: created, failed, total: coupons.length });
  } catch (err) {
    console.error("Bulk import error:", err);
    res.status(500).json({ error: "Failed to import coupons" });
  }
});

// Generate a batch of unique random coupon codes sharing one discount config (admin only)
router.post("/generate", requireAdmin, async (req, res) => {
  const { count, prefix, description, discount_type, discount_value, max_uses, expires_at, restrict_product, pool: poolTag } =
    req.body as {
      count: number;
      prefix?: string;
      description?: string;
      discount_type: "percentage" | "fixed";
      discount_value: number;
      max_uses?: number;
      expires_at?: string;
      restrict_product?: string;
      pool?: string;
    };

  if (!count || count < 1 || count > 500) {
    return res.status(400).json({ error: "count must be between 1 and 500" });
  }

  if (!discount_type || discount_value === undefined) {
    return res.status(400).json({ error: "discount_type and discount_value required" });
  }

  if (!["percentage", "fixed"].includes(discount_type)) {
    return res.status(400).json({ error: "discount_type must be 'percentage' or 'fixed'" });
  }

  if (!isWooCommerceConfigured()) {
    return res.status(500).json({ error: "WooCommerce is not configured on the server" });
  }

  let productIds: number[] | undefined;
  if (restrict_product) {
    try {
      const products = await searchWooCommerceProducts(restrict_product);
      if (products.length === 0) {
        return res.status(400).json({ error: `No product found on the store matching '${restrict_product}'` });
      }
      productIds = [products[0].id];
    } catch (err) {
      console.error("WooCommerce product search error:", err);
      return res.status(502).json({ error: "Failed to look up product on the store" });
    }
  }

  const cleanPrefix = (prefix || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

  const randomCode = () => {
    let suffix = "";
    for (let i = 0; i < 6; i++) {
      suffix += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return cleanPrefix ? `${cleanPrefix}-${suffix}` : suffix;
  };

  const wcDiscountType = discount_type === "percentage" ? "percent" : "fixed_cart";

  try {
    const codes: string[] = [];
    let failed = 0;

    for (let i = 0; i < count; i++) {
      let code = "";
      for (let attempt = 0; attempt < 10; attempt++) {
        const candidate = randomCode();
        const { rows } = await pool.query("SELECT 1 FROM coupons WHERE code = $1", [candidate]);
        if (rows.length === 0) {
          code = candidate;
          break;
        }
      }

      if (!code) {
        return res.status(500).json({ error: "Could not generate enough unique codes, try again" });
      }

      try {
        await createWooCommerceCoupon({
          code,
          amount: String(discount_value),
          discount_type: wcDiscountType,
          description: description || undefined,
          product_ids: productIds,
          usage_limit: max_uses || 1,
          usage_limit_per_user: 1,
          date_expires: expires_at || undefined,
        });
      } catch (err) {
        console.error(`WooCommerce coupon creation failed for ${code}:`, err);
        failed++;
        continue;
      }

      await pool.query(
        `INSERT INTO coupons (code, description, discount_type, discount_value, max_uses, expires_at, pool)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [code, description || null, discount_type, discount_value, max_uses || 1, expires_at || null, poolTag || null]
      );
      codes.push(code);
    }

    if (codes.length === 0) {
      return res.status(502).json({ error: "Failed to create coupons on the store" });
    }

    res.status(201).json({ codes, count: codes.length, failed });
  } catch (err) {
    console.error("Generate coupons error:", err);
    res.status(500).json({ error: "Failed to generate coupon codes" });
  }
});

// Claim a coupon code from a pool (e.g. birthday gift options) - member-facing
router.post("/claim", async (req, res) => {
  const { pool: poolTag, email } = req.body as { pool?: string; email?: string };

  if (!poolTag || !email) {
    return res.status(400).json({ error: "pool and email required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows: existing } = await client.query(
      `SELECT c.code, c.discount_type, c.discount_value
       FROM coupon_redemptions r
       JOIN coupons c ON c.id = r.coupon_id
       WHERE c.pool = $1 AND r.user_id = $2
       LIMIT 1`,
      [poolTag, email]
    );

    if (existing.length > 0) {
      await client.query("COMMIT");
      return res.json({
        code: existing[0].code,
        discount_type: existing[0].discount_type,
        discount_value: existing[0].discount_value,
        alreadyClaimed: true,
      });
    }

    const { rows: available } = await client.query(
      `SELECT id, code, discount_type, discount_value FROM coupons
       WHERE pool = $1 AND used_count < COALESCE(max_uses, 1)
       ORDER BY id
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
      [poolTag]
    );

    if (available.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "No codes available in this pool" });
    }

    const coupon = available[0];

    await client.query("UPDATE coupons SET used_count = used_count + 1 WHERE id = $1", [coupon.id]);
    await client.query("INSERT INTO coupon_redemptions (coupon_id, user_id) VALUES ($1, $2)", [coupon.id, email]);

    await client.query("COMMIT");
    res.json({
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
      alreadyClaimed: false,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Claim coupon error:", err);
    res.status(500).json({ error: "Failed to claim coupon code" });
  } finally {
    client.release();
  }
});

// Validate and redeem a coupon
router.post("/redeem", async (req, res) => {
  const { code, userId } = req.body as { code?: string; userId?: string };

  if (!code || !userId) {
    return res.status(400).json({ error: "Code and userId required" });
  }

  try {
    const { rows } = await pool.query(
      `SELECT id, code, discount_type, discount_value, max_uses, used_count, expires_at
       FROM coupons WHERE code = $1`,
      [code.toUpperCase()]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: "Coupon not found" });
    }

    const coupon = rows[0];

    // Check expiration
    if (coupon.expires_at && new Date(coupon.expires_at) < new Date()) {
      return res.status(400).json({ error: "Coupon has expired" });
    }

    // Check max uses
    if (coupon.max_uses && coupon.used_count >= coupon.max_uses) {
      return res.status(400).json({ error: "Coupon usage limit reached" });
    }

    // Check if already redeemed by this user
    const { rows: existing } = await pool.query(
      `SELECT id FROM coupon_redemptions WHERE coupon_id = $1 AND user_id = $2`,
      [coupon.id, userId]
    );

    if (existing.length > 0) {
      return res.status(400).json({ error: "You have already redeemed this coupon" });
    }

    // Record redemption and increment used count
    await pool.query("INSERT INTO coupon_redemptions (coupon_id, user_id) VALUES ($1, $2)", [coupon.id, userId]);

    await pool.query("UPDATE coupons SET used_count = used_count + 1 WHERE id = $1", [coupon.id]);

    res.json({
      valid: true,
      code: coupon.code,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
    });
  } catch (err) {
    console.error("Redeem coupon error:", err);
    res.status(500).json({ error: "Failed to redeem coupon" });
  }
});

// Delete a coupon (admin only)
router.delete("/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    await pool.query("DELETE FROM coupon_redemptions WHERE coupon_id = $1", [id]);
    await pool.query("DELETE FROM coupons WHERE id = $1", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete coupon error:", err);
    res.status(500).json({ error: "Failed to delete coupon" });
  }
});

export default router;
