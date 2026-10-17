import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import HttpError from "../models/http-error.js";
import { trackExternalCall } from "../middleware/metrics.js";
import logger from "./logger.js";

const locationLogger = logger.child({ component: "location" });

/**
 * Fallback geocoder using Gemini if Google Maps Geocoding API fails or has key restrictions.
 */
async function getCoordsWithGemini(address) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is missing for fallback geocoding");
  }

  const ai = new GoogleGenAI({ apiKey });
  const prompt = `You are an accurate geospatial geocoding engine.
Determine the precise latitude and longitude coordinates for this address/place:
"${address}"

Return STRICTLY a JSON object with numeric "lat" and "lng":
{
  "lat": number,
  "lng": number
}`;

  let response;
  try {
    response = await ai.models.generateContent({
      model: "gemini-3.8-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });
  } catch (err) {
    response = await ai.models.generateContent({
      model: "gemini-1.5-flash",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        temperature: 0.1,
      },
    });
  }

  const parsed = JSON.parse(response.text?.trim() || "{}");
  if (
    typeof parsed.lat === "number" &&
    typeof parsed.lng === "number" &&
    !isNaN(parsed.lat) &&
    !isNaN(parsed.lng)
  ) {
    locationLogger.info("Resolved coordinates via Gemini fallback", {
      address,
      coords: parsed,
    });
    return { lat: parsed.lat, lng: parsed.lng };
  }

  throw new Error("Could not parse coordinates from Gemini response");
}

async function getCoordsForAddress(address) {
  if (!address || address.trim().length === 0) {
    throw new HttpError("Address is required", 422);
  }

  const API_KEY = process.env.GMAP_GEOCODE_API_KEY;

  if (API_KEY) {
    try {
      const response = await trackExternalCall(
        "google_geocoding",
        "forward_geocode",
        () =>
          axios.get("https://maps.googleapis.com/maps/api/geocode/json", {
            params: {
              address,
              key: API_KEY,
            },
          }),
      );

      const data = response.data;
      if (data && data.status === "OK" && data.results && data.results.length > 0) {
        return data.results[0].geometry.location;
      }

      locationLogger.warn("Google Maps geocoding returned non-OK status", {
        address,
        responseStatus: data?.status,
        errorMessage: data?.error_message,
      });
    } catch (error) {
      locationLogger.warn("Google Maps geocoding request error, attempting fallback", {
        address,
        error: error.message,
      });
    }
  }

  // Fallback to Gemini geocoding if Google Maps API key is restricted or failed
  try {
    return await getCoordsWithGemini(address);
  } catch (geminiError) {
    locationLogger.error("Both Google Maps and Gemini geocoding failed", {
      address,
      error: geminiError.message,
    });
    throw new HttpError("Could not find location for specified address", 422);
  }
}

export default getCoordsForAddress;
