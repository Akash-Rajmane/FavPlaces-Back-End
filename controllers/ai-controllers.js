import HttpError from "../models/http-error.js";
import User from "../models/user.js";
import {
  analyzePlaceImage,
  polishPlaceDescription,
  askPlaceAssistant,
} from "../services/gemini-service.js";

/**
 * Controller: Analyze image from uploaded file buffer
 * POST /api/ai/analyze-image
 */
export const analyzeImageHandler = async (req, res, next) => {
  const requestLogger = req.logger || console;

  if (!req.file || !req.file.buffer) {
    return next(new HttpError("No image file provided for analysis.", 400));
  }

  try {
    requestLogger.info?.("Analyzing image with Gemini Vision...");
    const result = await analyzePlaceImage(req.file.buffer, req.file.mimetype);

    res.status(200).json({
      status: "success",
      data: result,
    });
  } catch (err) {
    requestLogger.error?.("Gemini analyze-image error:", { error: err.message });
    return next(
      new HttpError(
        "Could not analyze image with Gemini. Please try again or fill in manually.",
        500
      )
    );
  }
};

/**
 * Controller: Polish or re-tone place description
 * POST /api/ai/polish-description
 * Body: { description, title, tone }
 */
export const polishDescriptionHandler = async (req, res, next) => {
  const requestLogger = req.logger || console;
  const { description, title, tone } = req.body;

  if (!description || typeof description !== "string" || !description.trim()) {
    return next(
      new HttpError("Please provide a description or draft to polish.", 400)
    );
  }

  try {
    requestLogger.info?.("Polishing description with Gemini...", { tone, title });
    const polishedText = await polishPlaceDescription(description, title, tone);

    res.status(200).json({
      status: "success",
      polishedDescription: polishedText,
    });
  } catch (err) {
    requestLogger.error?.("Gemini polish-description error:", {
      error: err.message,
    });
    return next(
      new HttpError(
        "Could not polish description with Gemini. Please try again.",
        500
      )
    );
  }
};

/**
 * Controller: Ask interactive place assistant Q&A
 * POST /api/ai/ask-place
 * Body: { place: { title, address, description }, question, history }
 */
export const askPlaceAssistantHandler = async (req, res, next) => {
  const requestLogger = req.logger || console;
  const { place, question, history } = req.body;

  if (!question || typeof question !== "string" || !question.trim()) {
    return next(new HttpError("Please provide a question for the assistant.", 400));
  }

  try {
    requestLogger.info?.("Asking Gemini place assistant...", {
      placeTitle: place?.title,
      question,
    });
    const answer = await askPlaceAssistant(place || {}, question, history || []);

    res.status(200).json({
      status: "success",
      answer,
    });
  } catch (err) {
    console.error("Gemini ask-place error detail:", err);
    requestLogger.error?.("Gemini ask-place error:", { error: err.message, stack: err.stack });
    return next(
      new HttpError(
        err.message || "Could not get an answer from the assistant. Please try again.",
        500
      )
    );
  }
};

/**
 * Controller: Autonomous Trip Planner (RAG + MCP)
 * POST /api/ai/plan-trip
 * Body: { city, days, vibe, onlyMyPlaces }
 */
export const planTripHandler = async (req, res, next) => {
  const requestLogger = req.logger || console;
  const { city, days, vibe, startDate, onlyMyPlaces } = req.body;
  const userId = req.userData?.userId;

  if (!userId) {
    return next(new HttpError("Authentication required. Please log in to use Trip Planner.", 401));
  }

  let user;
  try {
    user = await User.findById(userId);
  } catch (err) {
    return next(new HttpError("Fetching user data failed, please try again later.", 500));
  }

  if (!user || !user.isPremium) {
    return next(
      new HttpError(
        "Trip Planner is a Premium feature. Please upgrade to FavPlaces Pro to unlock AI Trip Planning.",
        403
      )
    );
  }

  try {
    requestLogger.info?.("Planning trip with RAG + MCP...", { city, days, vibe, startDate });
    const { planAutonomousTrip } = await import("../services/trip-planner-service.js");

    const tripPlan = await planAutonomousTrip({
      city: city || "Pune",
      days: Number(days) || 1,
      vibe: vibe || "Scenic, relaxed, local food, and cultural highlights",
      startDate: startDate || null,
      onlyMyPlaces: !!onlyMyPlaces,
      userId,
    });

    res.status(200).json({
      status: "success",
      plan: tripPlan,
    });
  } catch (err) {
    console.error("Trip planning error:", err);
    requestLogger.error?.("Trip planning error:", { error: err.message, stack: err.stack });

    let cleanMessage = err.message || "Failed to plan trip. Please try again.";
    if (typeof cleanMessage === "string" && (cleanMessage.includes('{"error"') || cleanMessage.startsWith("{"))) {
      try {
        const parsed = JSON.parse(cleanMessage);
        if (parsed.error?.code === 503 || parsed.error?.message?.includes("high demand") || parsed.error?.status === "UNAVAILABLE") {
          cleanMessage = "AI travel servers are currently experiencing temporary high traffic. Please wait 10 seconds and try again.";
        } else if (parsed.error?.message) {
          cleanMessage = parsed.error.message;
        }
      } catch (_) {
        cleanMessage = "AI trip generation service is temporarily busy. Please try again shortly.";
      }
    }

    return next(new HttpError(cleanMessage, 503));
  }
};

