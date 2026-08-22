import { verifyAppJwt } from "../services/auth.js";
import { AUTH_REQUIRED } from "../config.js";
import { setLogContext } from "../services/logger.js";

function extractBearer(req) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme === "Bearer" && token) return token;
  // PDF iframe / object cannot set Authorization — allow ?token= for GET only.
  if (req.method === "GET" && typeof req.query?.token === "string" && req.query.token) {
    return req.query.token;
  }
  return null;
}

/**
 * Require `Authorization: Bearer <app-jwt>` (or `?token=` on GET for PDF viewer).
 * Stateless JWT auth — no Passport, no sessions.
 */
export function requireAuth(req, res, next) {
  if (!AUTH_REQUIRED) {
    req.user = null;
    return next();
  }

  const token = extractBearer(req);
  if (!token) {
    return res.status(401).json({ error: "Unauthorized", message: "Sign in required" });
  }

  try {
    req.user = verifyAppJwt(token);
    setLogContext({ userId: req.user?.id || req.user?.sub || null });
    return next();
  } catch (err) {
    return res.status(err?.status || 401).json({
      error: "Unauthorized",
      message: err?.message || "Invalid token",
    });
  }
}
