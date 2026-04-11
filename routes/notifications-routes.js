import express from "express";
import * as notificationsController from "../controllers/notifications-controller.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

/**
 * Notifications must always return a full body (never 304): Express sets ETags on
 * JSON and browsers send If-None-Match, which triggers conditional responses.
 * Strip validators and forbid caching on this router.
 */
const noHttpCache = (req, res, next) => {
  delete req.headers["if-none-match"];
  delete req.headers["if-modified-since"];
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate, max-age=0",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
};

router.use(checkAuth);
router.use(noHttpCache);

router.get("/", notificationsController.getNotifications);
router.patch("/:nid/read", notificationsController.markAsRead);

export default router;
