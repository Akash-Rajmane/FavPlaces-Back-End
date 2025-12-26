const express = require("express");

const pushController = require("../controllers/push-controller");
const checkAuth = require("../middleware/check-auth");

const router = express.Router();

// All push routes require authentication
router.use(checkAuth);

router.post("/subscribe", pushController.subscribe);
router.post("/unsubscribe", pushController.unsubscribe);

module.exports = router;
