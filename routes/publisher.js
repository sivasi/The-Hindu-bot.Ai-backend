import { Router } from "express";
import multer from "multer";

import { isPublisherEmail } from "../config.js";
import { requireAuth } from "../middleware/auth.js";
import { requirePublisher } from "../middleware/requirePublisher.js";
import {
  MAX_PDF_BYTES,
  confirmNewspaperPdf,
  createNewspaperUploadUrl,
  uploadNewspaperPdf,
} from "../services/gcsPdfs.js";

const router = Router();
const pdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 1 },
});

/** Whether the signed-in Google account may call publisher upload routes. */
router.get("/access", requireAuth, (req, res) => {
  res.json({
    ok: true,
    allowed: isPublisherEmail(req.user?.email),
  });
});

router.post("/pdf/sign", requirePublisher, async (req, res) => {
  try {
    const signed = await createNewspaperUploadUrl(req.body?.date);
    res.json({ ok: true, ...signed });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || "Failed to create upload URL",
    });
  }
});

router.post("/pdf/complete", requirePublisher, async (req, res) => {
  try {
    const issue = await confirmNewspaperPdf(req.body?.date);
    res.json({ ok: true, ...issue });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || "Failed to confirm PDF upload",
    });
  }
});

router.post("/pdf", requirePublisher, pdfUpload.single("pdf"), async (req, res) => {
  try {
    const issue = await uploadNewspaperPdf(
      req.body?.date,
      req.file?.buffer,
      req.file?.mimetype
    );
    res.status(201).json({ ok: true, ...issue });
  } catch (err) {
    res.status(err?.status || 500).json({
      ok: false,
      error: err?.message || "Failed to upload PDF",
    });
  }
});

export default router;
