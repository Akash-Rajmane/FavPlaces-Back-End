const express = require("express");

const notificationsController = require("../controllers/notifications-controller");
const checkAuth = require("../middleware/check-auth");

const router = express.Router();

router.use(checkAuth);

router.get("/", notificationsController.getNotifications);
router.patch("/:nid/read", notificationsController.markAsRead);

module.exports = router;
