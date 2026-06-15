import { Router } from "express";
import { pool } from "../db";
import { requireAdmin } from "../middleware/adminAuth";

const router = Router();

interface CouponInput {
  code: string;
  description?: string;
  discount_type: "percentage" | "fixed";
  discount_value: number;
  max_uses?: number;
  expires_at?: string;
}

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
