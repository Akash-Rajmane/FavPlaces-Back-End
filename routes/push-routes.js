import express from "express";
import * as pushController from "../controllers/push-controller.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

// All push routes require authentication
router.use(checkAuth);

router.post("/subscribe", pushController.subscribe);
router.post("/unsubscribe", pushController.unsubscribe);

export default router;
