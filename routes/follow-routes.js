const express = require("express");

const followController = require("../controllers/follow-controller");
const checkAuth = require("../middleware/check-auth");

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

module.exports = router;
