import express from "express";
import { check } from "express-validator";
import * as placesControllers from "../controllers/places-controllers.js";
import { uploadPlaceImage } from "../middleware/file-upload.js";
import checkAuth from "../middleware/check-auth.js";

const router = express.Router();

router.get("/:pid", placesControllers.getPlaceById);

router.get("/user/:uid", placesControllers.getPlacesByUserId);

router.use(checkAuth);

router.post(
  "/",
  uploadPlaceImage.single("image"),
  [
    check("title").not().isEmpty(),
    check("description").isLength({ min: 5 }),
    check("address").not().isEmpty(),
  ],
  placesControllers.createPlace
);

router.patch(
  "/:pid",
  [check("title").not().isEmpty(), check("description").isLength({ min: 5 })],
  placesControllers.updatePlace
);

router.delete("/:pid", placesControllers.deletePlace);

export default router;
