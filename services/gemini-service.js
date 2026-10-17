import { GoogleGenAI } from "@google/genai";
import logger from "../util/logger.js";

const aiLogger = logger.child({ component: "gemini-service" });

const PRIMARY_MODEL = "gemini-3.8-flash";
const FALLBACK_MODEL = "gemini-1.5-flash";

const getGenAIClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not configured in server environment.");
  }
  return new GoogleGenAI({ apiKey });
};

/**
 * Generate content using primary model with automatic fallback.
 */
const generateWithFallback = async (params) => {
  const ai = getGenAIClient();
  try {
    return await ai.models.generateContent({
      model: PRIMARY_MODEL,
      ...params,
    });
  } catch (err) {
    aiLogger.warn(`Primary model ${PRIMARY_MODEL} failed, attempting ${FALLBACK_MODEL}:`, {
      error: err.message,
    });
    return await ai.models.generateContent({
      model: FALLBACK_MODEL,
      ...params,
    });
  }
};

/**
 * Feature 1: Analyze an uploaded image to predict place title, description, address, and tags.
 * @param {Buffer} imageBuffer - Image binary buffer
 * @param {string} mimeType - e.g. "image/jpeg", "image/png"
 */
export const analyzePlaceImage = async (imageBuffer, mimeType = "image/jpeg") => {
  const base64Data = imageBuffer.toString("base64");

  const prompt = `You are a world-class travel expert and local city guide.
Analyze this photo of a place, travel destination, restaurant, cafe, scenic viewpoint, or landmark.

Extract and infer as much specific detail as possible:
1. "title": A concise, engaging title for this place (e.g., "Duomo di Milano Rooftop", "Cozy Corner at Cafe de Flore", "Sunset at Santa Monica Pier"). If it is a generic spot (like a cozy cafe or beach), give it an appealing, descriptive name.
2. "address": The most likely address, neighborhood, city, or country. Be as specific as reasonable. If unknown, provide the best guess of the region/city or city format.
3. "description": An evocative 2-4 sentence description highlighting the vibe, atmosphere, best time to visit, and what makes it special.
4. "tags": An array of 4-6 concise tags (e.g. ["scenic-view", "sunset", "historic", "cafe", "architecture"]).

Return STRICTLY a JSON object matching this schema:
{
  "title": string,
  "address": string,
  "description": string,
  "tags": string[]
}`;

  const response = await generateWithFallback({
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          {
            inlineData: {
              data: base64Data,
              mimeType: mimeType || "image/jpeg",
            },
          },
        ],
      },
    ],
    config: {
      responseMimeType: "application/json",
      temperature: 0.4,
    },
  });

  const rawText = response.text?.trim() || "{}";
  try {
    return JSON.parse(rawText);
  } catch (parseError) {
    aiLogger.error("Failed to parse Gemini JSON output", { rawText, error: parseError.message });
    // Clean potential markdown blocks if any
    const cleaned = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
    return JSON.parse(cleaned);
  }
};

/**
 * Feature 2: Polish and enhance a place description according to a chosen tone/persona.
 * @param {string} currentText - Existing user notes or description
 * @param {string} title - Title of the place (optional context)
 * @param {string} tone - Tone style ("aesthetic", "practical", "foodie", "concise")
 */
export const polishPlaceDescription = async (currentText, title = "", tone = "aesthetic") => {
  const tonePrompts = {
    aesthetic:
      "Vivid, atmospheric, and poetic—like a high-end travel magazine or curated travel journal. Capture lighting, sensations, and ambiance.",
    practical:
      "Clear, informative, and actionable. Highlight visitor tips, best times, ease of access, and essentials.",
    foodie:
      "Enthusiastic culinary explorer tone. Emphasize flavors, must-tries, ambiance, aromas, and dining experience.",
    concise:
      "Punchy, engaging, and brief (2-3 sentences max). Quick highlights and standout reason to visit.",
  };

  const selectedTone = tonePrompts[tone] || tonePrompts.aesthetic;

  const prompt = `You are a helpful travel writer assistant for the FavPlaces app.
Enhance and rewrite the following place description while keeping the core facts accurate.

Context:
- Place Title: "${title || "Unspecified"}"
- Current Draft / Notes: "${currentText}"
- Desired Tone: ${selectedTone}

Guidelines:
- Maintain authenticity; do not hallucinate false facts that conflict with the original notes.
- Enhance flow, vocabulary, and emotional resonance.
- Keep the length to 2-4 well-crafted sentences (unless concise is chosen, which should be 1-2).
- Return ONLY the enhanced description as plain text, without quotes, prefixes, or commentary.`;

  const response = await generateWithFallback({
    contents: prompt,
    config: {
      temperature: 0.7,
    },
  });

  return response.text?.trim() || currentText;
};

/**
 * Feature 4: Interactive Place Assistant (Ask AI about a place)
 * @param {object} placeContext - { title, address, description }
 * @param {string} userQuestion - The question asked by the user
 * @param {Array} history - Previous messages [{ role: "user" | "model", parts: [{ text }] }]
 */
export const askPlaceAssistant = async (placeContext, userQuestion, history = []) => {
  const systemInstruction = `You are "FavPlaces Concierge", a warm, knowledgeable, and helpful travel & dining assistant.
You are helping a visitor learn about this specific place:
- Title: ${placeContext.title || "Unknown place"}
- Address / Location: ${placeContext.address || "Unknown location"}
- Creator's Notes: ${placeContext.description || "No description provided."}

Guidelines:
- Answer the user's questions clearly, concisely, and accurately based on the place info and your extensive real-world knowledge of this destination/city.
- Provide practical recommendations: best time of day to visit, popular signature dishes/drinks, photography tips, parking/transport advice, or crowd levels when asked.
- Keep answers formatted nicely with bullet points if helpful. Keep it concise (under 150 words) unless they ask for an in-depth guide.
- Be friendly, encouraging, and enthusiastic about travel!`;

  // Sanitize history to ensure alternating user/model turns ending with the new user question
  const sanitizedContents = [];
  let expectedRole = "user";

  for (const item of history.slice(-6)) {
    const role = item.role === "user" ? "user" : "model";
    const text = item.parts?.[0]?.text?.trim() || "";
    if (text && role === expectedRole) {
      sanitizedContents.push({
        role,
        parts: [{ text }],
      });
      expectedRole = role === "user" ? "model" : "user";
    }
  }

  // Ensure last message is from user
  sanitizedContents.push({
    role: "user",
    parts: [{ text: userQuestion }],
  });

  const response = await generateWithFallback({
    contents: sanitizedContents,
    config: {
      systemInstruction,
      temperature: 0.7,
    },
  });

  return response.text?.trim() || "I couldn't find an answer for that right now. Please try again!";
};

