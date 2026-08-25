import { requireAuth } from "./auth.js";
import { isPublisherEmail } from "../config.js";

/**
 * Same Google JWT as the rest of the API, plus an email allow-list.
 */
export function requirePublisher(req, res, next) {
  requireAuth(req, res, () => {
    if (res.headersSent) return;
    if (!isPublisherEmail(req.user?.email)) {
      return res.status(403).json({
        error: "Forbidden",
        message: "Only the archive publisher can upload PDFs",
      });
    }
    return next();
  });
}
