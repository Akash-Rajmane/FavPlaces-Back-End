import express from "express";
import checkAuth from "../middleware/check-auth.js";
import {
  createOrder,
  verifyPayment,
  getPaymentStatus,
} from "../controllers/payment-controllers.js";

const router = express.Router();

// All payment routes require active authentication
router.use(checkAuth);

router.post("/create-order", createOrder);
router.post("/verify", verifyPayment);
router.get("/status", getPaymentStatus);

export default router;
