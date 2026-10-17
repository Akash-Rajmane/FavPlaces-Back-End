import express from "express";
import multer from "multer";
import checkAuth from "../middleware/check-auth.js";
import {
  analyzeImageHandler,
  polishDescriptionHandler,
  askPlaceAssistantHandler,
} from "../controllers/ai-controllers.js";

const router = express.Router();

// In-memory multer storage specifically for temporary AI image processing
const memoryStorage = multer.memoryStorage();
const uploadMemory = multer({
  storage: memoryStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

// POST /api/ai/ask-place (Accessible to all users viewing a place)
router.post("/ask-place", askPlaceAssistantHandler);

// Protect creation/editing AI endpoints with authenticated session
router.use(checkAuth);

// POST /api/ai/analyze-image
router.post(
  "/analyze-image",
  uploadMemory.single("image"),
  analyzeImageHandler
);

// POST /api/ai/polish-description
router.post("/polish-description", polishDescriptionHandler);

export default router;
