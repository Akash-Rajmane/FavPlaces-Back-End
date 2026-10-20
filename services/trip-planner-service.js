import Place from "../models/place.js";
import { generateEmbedding, askPlaceAssistant } from "./gemini-service.js";
import {
  getLiveWeatherTool,
  optimizeRouteOrderTool,
  generateCalendarEventsTool,
} from "./mcp-tools.js";
import logger from "../util/logger.js";
import { GoogleGenAI } from "@google/genai";

const plannerLogger = logger.child({ component: "trip-planner" });

/**
 * Plan an autonomous trip using RAG (Vector Search across all places or user's places)
 * and MCP (Live Weather, Geospatial Route Optimization, and Calendar Event generation).
 */
export const planAutonomousTrip = async ({
  city,
  days = 1,
  vibe = "Scenic, relaxed, local food, and cultural highlights",
  startDate = null,
  onlyMyPlaces = false,
  userId = null,
}) => {
  plannerLogger.info("Starting autonomous trip planning...", {
    city,
    days,
    vibe,
    startDate,
    onlyMyPlaces,
  });

  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 1: Generating embedding for city=${city}...`);
  // 1. RAG STEP: Vectorize the user's travel intent
  const queryText = `Best places, attractions, cafes, viewpoints, and hidden gems in ${city || ""}. Vibe: ${vibe}`;
  const queryVector = await generateEmbedding(queryText);
  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 1 DONE: Vector length=${queryVector?.length}`);

  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 2: Querying MongoDB candidate spots...`);
  // 2. RAG STEP: Retrieve candidate spots from MongoDB
  let candidatePlaces = [];

  try {
    // Attempt MongoDB Atlas Vector Search
    const vectorPipeline = [
      {
        $vectorSearch: {
          index: "places_vector_index",
          path: "embedding",
          queryVector: queryVector,
          numCandidates: 40,
          limit: 12,
        },
      },
      {
        $project: {
          title: 1,
          description: 1,
          address: 1,
          location_geo: 1,
          image: 1,
          creator: 1,
          score: { $meta: "vectorSearchScore" },
        },
      },
    ];

    if (onlyMyPlaces && userId) {
      vectorPipeline[0].$vectorSearch.filter = { creator: userId };
    }

    candidatePlaces = await Place.aggregate(vectorPipeline);
  } catch (vectorSearchError) {
    plannerLogger.warn(
      "Atlas $vectorSearch failed or index still initializing, falling back to text & geo match:",
      { error: vectorSearchError.message }
    );

    // Fallback: search by city regex or grab recent popular places
    const filter = {};
    if (city) {
      filter.$or = [
        { address: { $regex: city, $options: "i" } },
        { title: { $regex: city, $options: "i" } },
        { description: { $regex: city, $options: "i" } },
      ];
    }
    if (onlyMyPlaces && userId) {
      filter.creator = userId;
    }

    candidatePlaces = await Place.find(filter)
      .limit(10)
      .select("+embedding")
      .lean();
  }

  // If still empty (e.g. brand new city), retrieve overall top community places
  if (!candidatePlaces || candidatePlaces.length === 0) {
    candidatePlaces = await Place.find().limit(8).lean();
  }

  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 2 DONE: Found ${candidatePlaces.length} candidate spots.`);
  // 3. MCP STEP: Route Optimization (Order spots by proximity)
  const placeStops = candidatePlaces.map((p) => ({
    id: p._id,
    title: p.title,
    address: p.address,
    description: p.description,
    image: p.image,
    lat: p.location_geo?.coordinates?.[1] || 18.5204,
    lng: p.location_geo?.coordinates?.[0] || 73.8567,
  }));

  const optimizedStops = optimizeRouteOrderTool({ places: placeStops });

  // 4. MCP STEP: Live Weather Check using first stop's coordinates
  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 4: Calling live weather...`);
  const anchorLat = optimizedStops[0]?.lat || 18.5204;
  const anchorLng = optimizedStops[0]?.lng || 73.8567;
  const liveWeather = await getLiveWeatherTool({ lat: anchorLat, lng: anchorLng });
  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 4 DONE: Weather=${liveWeather.currentTemperature}`);

  // 5. SYNTHESIS STEP: Gemini builds a realistic, timed itinerary
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const dateInfo = startDate ? `Trip starting on: ${startDate}` : "Flexible / upcoming dates";
  const prompt = `You are the FavPlaces Autonomous Travel Architect.
Create an inspiring, highly realistic ${days}-day itinerary for ${city || "this destination"}.

Target Vibe: ${vibe}
Trip Dates: ${dateInfo}
Live Weather Conditions: Temperature ${liveWeather.currentTemperature}, Rain Risk ${liveWeather.forecastSummary?.rainChance || "Low"}
Retrieved Community Favorite Places (in optimized route order):
${JSON.stringify(
  optimizedStops.map((s, idx) => ({
    number: idx + 1,
    title: s.title,
    address: s.address,
    description: s.description,
    distanceFromPrevious: s.distanceFromPrevious || "Start",
  })),
  null,
  2
)}

Format the output strictly as a JSON object with this exact structure:
{
  "tripTitle": string,
  "summary": string,
  "weatherNote": string,
  "days": [
    {
      "dayNumber": number,
      "theme": string,
      "schedule": [
        {
          "timeSlot": string (e.g. "09:00 AM - 10:30 AM"),
          "placeTitle": string,
          "address": string,
          "activity": string,
          "travelTip": string
        }
      ]
    }
  ]
}`;

  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 5: Calling Gemini for full itinerary synthesis...`);
  const candidateModels = ["gemini-3.5-flash-lite", "gemini-3.8-flash", "gemini-3.1-flash-lite"];
  let rawJson = null;
  let lastError = null;

  for (const modelName of candidateModels) {
    try {
      console.log(`[TRIP PLANNER] Attempting synthesis with ${modelName}...`);
      const aiResponse = await ai.models.generateContent({
        model: modelName,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          temperature: 0.4,
        },
      });
      const text = aiResponse.text?.trim();
      if (text) {
        rawJson = text;
        console.log(`[TRIP PLANNER] Synthesis SUCCESS with ${modelName}`);
        break;
      }
    } catch (modelErr) {
      console.warn(`[TRIP PLANNER] Model ${modelName} failed:`, modelErr.message);
      lastError = modelErr;
    }
  }

  if (!rawJson) {
    const errMsg = lastError?.message || "";
    if (errMsg.includes("503") || errMsg.includes("high demand") || errMsg.includes("UNAVAILABLE")) {
      throw new Error("AI service is currently experiencing high demand. Please wait a few seconds and try again.");
    }
    if (errMsg.includes("429") || errMsg.includes("quota")) {
      throw new Error("AI request limit reached. Please wait a moment and try again.");
    }
    throw new Error("AI trip generation is momentarily busy. Please try again in a few moments.");
  }

  console.log(`[TRIP PLANNER] [${new Date().toISOString()}] Step 5 DONE: Received JSON length=${rawJson.length}`);

  let parsedPlan;
  try {
    parsedPlan = JSON.parse(rawJson);
  } catch (jsonErr) {
    console.error("[TRIP PLANNER] Failed to parse generated JSON:", rawJson);
    throw new Error("Generated itinerary could not be parsed. Please try generating again.");
  }

  // Flatten schedule items for Calendar tool
  const flattenedSchedule = [];
  (parsedPlan.days || []).forEach((d) => {
    (d.schedule || []).forEach((item) => {
      flattenedSchedule.push({
        day: d.dayNumber,
        title: item.placeTitle,
        timeSlot: item.timeSlot,
        address: item.address,
        description: `${item.activity} - Tip: ${item.travelTip}`,
      });
    });
  });

  // 6. MCP STEP: Generate Calendar Sync File (.ics)
  const calendarData = generateCalendarEventsTool({
    tripTitle: parsedPlan.tripTitle || `Trip to ${city}`,
    scheduleItems: flattenedSchedule,
    startDate,
  });

  return {
    ...parsedPlan,
    liveWeather,
    calendarData,
    retrievedPlacesCount: candidatePlaces.length,
    stops: optimizedStops,
  };
};
