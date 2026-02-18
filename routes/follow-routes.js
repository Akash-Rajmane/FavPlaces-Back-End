import express from "express";
import * as followController from "../controllers/follow-controller.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

// All routes below require authentication
router.use(checkAuth);

// Send follow request
router.post("/request", followController.requestFollow);

// Get pending follow requests
router.get("/requests", followController.getFollowRequests);

// Accept follow request
router.post("/accept", followController.acceptFollow);

// Reject follow request
router.post("/reject", followController.rejectFollow);

export default router;
