import express from "express";
import { check } from "express-validator";
import * as usersControllers from "../controllers/users-controllers.js";
import { uploadUserImage } from "../middleware/file-upload.js";
import optionalAuth from "../middleware/optional-auth.js";

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

export default router;
