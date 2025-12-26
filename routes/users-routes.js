const express = require("express");
const { check } = require("express-validator");

const usersControllers = require("../controllers/users-controllers");
const { uploadUserImage } = require("../middleware/file-upload");
const optionalAuth = require("../middleware/check-auth");

const router = express.Router();

router.get("/", optionalAuth, usersControllers.getUsers);

router.post(
  "/signup",
  uploadUserImage.single("image"),
  [
    check("name").not().isEmpty(),
    check("email").normalizeEmail().isEmail(),
    check("password").isLength({ min: 8 }),
  ],
  usersControllers.signup
);

router.post("/login", usersControllers.login);

module.exports = router;
