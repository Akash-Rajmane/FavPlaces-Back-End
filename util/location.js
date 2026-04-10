import axios from "axios";
import HttpError from "../models/http-error.js";
import { trackExternalCall } from "../middleware/metrics.js";
import logger from "./logger.js";

const API_KEY = process.env.GMAP_GEOCODE_API_KEY;
const locationLogger = logger.child({ component: "location" });

async function getCoordsForAddress(address) {
  if (!address || address.trim().length === 0) {
    throw new HttpError("Address is required", 422);
  }

  if (!API_KEY) {
    locationLogger.error("Google Maps geocoding API key is missing");
    throw new HttpError("Geocoding API key missing", 500);
  }

  let response;

  try {
    response = await trackExternalCall(
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
  } catch (error) {
    locationLogger.error("Geocoding request failed", {
      address,
      error,
      statusCode: error.response?.status,
      responseStatus: error.response?.data?.status,
    });
    throw new HttpError("Geocoding request failed", 500);
  }

  const data = response.data;
  locationLogger.debug("Geocode lookup completed", {
    address,
    responseStatus: data?.status,
    resultsCount: data?.results?.length || 0,
  });

  if (
    !data ||
    data.status !== "OK" ||
    !data.results ||
    data.results.length === 0
  ) {
    locationLogger.warn("Geocoding returned no results", {
      address,
      responseStatus: data?.status,
    });
    throw new HttpError("Could not find location for specified address", 422);
  }

  return data.results[0].geometry.location;
}

export default getCoordsForAddress;
