import express from "express";
import * as notificationsController from "../controllers/notifications-controller.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

router.use(checkAuth);

router.get("/", notificationsController.getNotifications);
router.patch("/:nid/read", notificationsController.markAsRead);

export default router;
