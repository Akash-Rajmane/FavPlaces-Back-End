const axios = require("axios");
const HttpError = require("../models/http-error");

const API_KEY = process.env.GMAP_GEOCODE_API_KEY;

async function getCoordsForAddress(address) {
  if (!address || address.trim().length === 0) {
    throw new HttpError("Address is required", 422);
  }

  if (!API_KEY) {
    console.error("❌ GMAP_API_KEY is missing");
    throw new HttpError("Geocoding API key missing", 500);
  }

  let response;

  try {
    response = await axios.get(
      "https://maps.googleapis.com/maps/api/geocode/json",
      {
        params: {
          address,
          key: API_KEY,
        },
      }
    );
  } catch (err) {
    // 🔴 THIS is why nothing was logging
    console.error("❌ Axios request failed");

    if (err.response) {
      console.error("Status:", err.response.status);
      console.error("Data:", err.response.data);
    } else {
      console.error("Error:", err.message);
    }

    throw new HttpError("Geocoding request failed", 500);
  }

  const data = response.data;
  console.log("✅ Geocode response:", data);

  if (
    !data ||
    data.status !== "OK" ||
    !data.results ||
    data.results.length === 0
  ) {
    throw new HttpError("Could not find location for specified address", 422);
  }

  return data.results[0].geometry.location;
}

module.exports = getCoordsForAddress;
