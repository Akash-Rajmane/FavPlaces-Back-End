const axios = require("axios");
const HttpError = require("../models/http-error");

const API_KEY = process.env.GMAP_API_KEY;

async function getCoordsForAddress(address) {
  const response = await axios.get(
    `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(
      address
    )}&key=${API_KEY}`
  );

  const data = response.data;

  if (!data || data.status === "ZERO_RESULTS") {
    const error = new HttpError(
      "Could not find location for specified address",
      422
    );
  }

  const coordiantes = data.results[0].geometry.location;

  return coordiantes;
}

module.exports = getCoordsForAddress;
