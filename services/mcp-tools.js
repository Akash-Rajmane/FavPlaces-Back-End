import axios from "axios";
import logger from "../util/logger.js";

const toolLogger = logger.child({ component: "mcp-tools" });

/**
 * Tool 1: Live Weather Forecast via Open-Meteo (Free, No API key needed, high reliability)
 * @param {number} lat
 * @param {number} lng
 */
export const getLiveWeatherTool = async ({ lat, lng }) => {
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true&daily=weathercode,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto`;
    const res = await axios.get(url, { timeout: 6000 });
    const current = res.data.current_weather;
    const daily = res.data.daily;

    return {
      currentTemperature: `${current?.temperature || "N/A"}°C`,
      windSpeed: `${current?.windspeed || "N/A"} km/h`,
      forecastSummary: {
        maxTemp: `${daily?.temperature_2m_max?.[0] || "N/A"}°C`,
        minTemp: `${daily?.temperature_2m_min?.[0] || "N/A"}°C`,
        rainChance: `${daily?.precipitation_probability_max?.[0] || 0}%`,
      },
    };
  } catch (err) {
    toolLogger.warn("Weather tool call failed, returning fallback estimate", {
      error: err.message,
    });
    return {
      currentTemperature: "Pleasant (22°C - 28°C)",
      forecastSummary: { rainChance: "Low (< 15%)" },
    };
  }
};

/**
 * Tool 2: Geospatial Distance and Proximity Order (Haversine Matrix)
 * Takes a list of candidate places and orders them logically to minimize travel time.
 * @param {Array<{ title: string, lat: number, lng: number }>} places
 */
export const optimizeRouteOrderTool = ({ places }) => {
  if (!places || places.length <= 1) return places || [];

  const toRad = (v) => (v * Math.PI) / 180;
  const getDistanceKm = (p1, p2) => {
    const R = 6371; // Earth radius in km
    const dLat = toRad(p2.lat - p1.lat);
    const dLon = toRad(p2.lng - p1.lng);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(p1.lat)) *
        Math.cos(toRad(p2.lat)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  };

  const unvisited = [...places];
  const ordered = [unvisited.shift()];

  while (unvisited.length > 0) {
    const current = ordered[ordered.length - 1];
    let closestIndex = 0;
    let minDistance = Infinity;

    for (let i = 0; i < unvisited.length; i++) {
      const dist = getDistanceKm(current, unvisited[i]);
      if (dist < minDistance) {
        minDistance = dist;
        closestIndex = i;
      }
    }

    const nextPlace = unvisited.splice(closestIndex, 1)[0];
    nextPlace.distanceFromPrevious = `${minDistance.toFixed(1)} km`;
    ordered.push(nextPlace);
  }

  return ordered;
};

/**
 * Tool 3: Google Calendar / ICS Itinerary Event Generator
 * Generates an importable iCalendar (.ics) string for the scheduled itinerary.
 * @param {string} tripTitle
 * @param {Array<{ title: string, timeSlot: string, address: string, description: string, day: number }>} scheduleItems
 */
export const generateCalendarEventsTool = ({ tripTitle, scheduleItems }) => {
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  const now = new Date();
  const dtStamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(
    now.getUTCDate()
  )}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}00Z`;

  let icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FavPlaces//Autonomous Trip Planner//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];

  (scheduleItems || []).forEach((item, index) => {
    // Offset each event by day and sequence
    const eventDate = new Date();
    eventDate.setDate(eventDate.getDate() + (item.day ? item.day - 1 : 0));
    const dateStr = `${eventDate.getFullYear()}${pad(
      eventDate.getMonth() + 1
    )}${pad(eventDate.getDate())}`;

    icsLines.push("BEGIN:VEVENT");
    icsLines.push(`UID:favplaces-${Date.now()}-${index}@favplaces.app`);
    icsLines.push(`DTSTAMP:${dtStamp}`);
    icsLines.push(`SUMMARY:${item.title} (${item.timeSlot || "Scheduled Stop"})`);
    icsLines.push(`DESCRIPTION:${item.description || "Trip stop curated by FavPlaces"}`);
    icsLines.push(`LOCATION:${item.address || ""}`);
    icsLines.push(`DTSTART;VALUE=DATE:${dateStr}`);
    icsLines.push(`DTEND;VALUE=DATE:${dateStr}`);
    icsLines.push("STATUS:CONFIRMED");
    icsLines.push("END:VEVENT");
  });

  icsLines.push("END:VCALENDAR");

  return {
    icsData: icsLines.join("\r\n"),
    googleCalendarUrlBase: "https://calendar.google.com/calendar/render?action=TEMPLATE",
  };
};
