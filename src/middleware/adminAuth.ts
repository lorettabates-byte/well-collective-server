import type { NextFunction, Request, Response } from "express";
import { verifyToken } from "../routes/auth";

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  // Try JWT token first (from Authorization header)
  const authHeader = req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    const payload = verifyToken(token);
    if (payload) {
      (req as any).admin = payload;
      next();
      return;
    }
  }

  // Fallback to x-admin-key for legacy/external requests
  const provided = req.header("x-admin-key");
  const expected = process.env.ADMIN_API_KEY;

  if (expected && provided === expected) {
    next();
    return;
  }

  res.status(401).json({ error: "Unauthorized" });
}

