import crypto from "crypto";
import Razorpay from "razorpay";
import HttpError from "../models/http-error.js";
import User from "../models/user.js";
import logger from "../util/logger.js";

const paymentLogger = logger.child({ component: "payment-controller" });

const getRazorpayInstance = () => {
  const key_id = process.env.RZP_API_KEY;
  const key_secret = process.env.RZP_API_SECRET;

  if (!key_id || !key_secret) {
    throw new Error("Razorpay credentials are missing in server environment variables.");
  }

  return new Razorpay({
    key_id,
    key_secret,
  });
};

/**
 * POST /api/payment/create-order
 * Creates a Razorpay order for upgrading to FavPlaces Pro (₹199 = 19900 paise)
 */
export const createOrder = async (req, res, next) => {
  const userId = req.userData?.userId;
  if (!userId) {
    return next(new HttpError("Authentication required.", 401));
  }

  try {
    const user = await User.findById(userId);
    if (!user) {
      return next(new HttpError("User not found.", 404));
    }

    if (user.isPremium) {
      return res.status(200).json({
        alreadyPremium: true,
        message: "You are already a FavPlaces Pro member!",
      });
    }

    const rzp = getRazorpayInstance();
    const amount = 19900; // ₹199 in paise
    const currency = "INR";
    const receipt = `rcpt_${userId.slice(-6)}_${Date.now()}`;

    const order = await rzp.orders.create({
      amount,
      currency,
      receipt,
      notes: {
        userId: userId.toString(),
        userEmail: user.email,
        plan: "FavPlaces Pro Lifetime Upgrade",
      },
    });

    paymentLogger.info("Created Razorpay order", {
      orderId: order.id,
      userId,
      amount,
    });

    res.status(201).json({
      orderId: order.id,
      currency: order.currency,
      amount: order.amount,
      keyId: process.env.RZP_API_KEY,
      userName: user.name,
      userEmail: user.email,
    });
  } catch (err) {
    paymentLogger.error("Failed to create Razorpay order", { error: err.message });
    return next(
      new HttpError(err.message || "Failed to initiate payment. Please try again.", 500)
    );
  }
};

/**
 * POST /api/payment/verify
 * Verifies Razorpay HMAC signature and upgrades user to isPremium: true
 */
export const verifyPayment = async (req, res, next) => {
  const userId = req.userData?.userId;
  if (!userId) {
    return next(new HttpError("Authentication required.", 401));
  }

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return next(new HttpError("Incomplete payment details provided.", 400));
  }

  try {
    const secret = process.env.RZP_API_SECRET;
    const body = `${razorpay_order_id}|${razorpay_payment_id}`;

    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(body.toString())
      .digest("hex");

    const isSignatureValid = expectedSignature === razorpay_signature;

    if (!isSignatureValid) {
      paymentLogger.warn("Payment signature mismatch", {
        userId,
        orderId: razorpay_order_id,
        paymentId: razorpay_payment_id,
      });
      return next(new HttpError("Payment verification failed! Invalid signature.", 400));
    }

    const user = await User.findById(userId);
    if (!user) {
      return next(new HttpError("User not found.", 404));
    }

    user.isPremium = true;
    user.orderId = razorpay_order_id;
    user.paymentId = razorpay_payment_id;
    await user.save();

    paymentLogger.info("User upgraded to Premium successfully", {
      userId,
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id,
    });

    res.status(200).json({
      status: "success",
      message: "Payment successfully verified! Welcome to FavPlaces Pro.",
      isPremium: true,
    });
  } catch (err) {
    paymentLogger.error("Error during payment verification", { error: err.message });
    return next(
      new HttpError("Payment verification process encountered an error. Please contact support.", 500)
    );
  }
};

/**
 * GET /api/payment/status
 * Check current user's premium status
 */
export const getPaymentStatus = async (req, res, next) => {
  const userId = req.userData?.userId;
  if (!userId) {
    return next(new HttpError("Authentication required.", 401));
  }

  try {
    const user = await User.findById(userId).select("isPremium paymentId orderId");
    if (!user) {
      return next(new HttpError("User not found.", 404));
    }

    res.status(200).json({
      isPremium: !!user.isPremium,
      paymentId: user.paymentId || null,
    });
  } catch (err) {
    return next(new HttpError("Failed to fetch subscription status.", 500));
  }
};
