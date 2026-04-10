import { algoliasearch } from "algoliasearch";
import dotenv from "dotenv";
import logger from "../util/logger.js";

dotenv.config();

const algoliaLogger = logger.child({ component: "algolia" });
const algoliaIndexName = process.env.ALGOLIA_INDEX_NAME || "places";

let client = null;

if (process.env.ALGOLIA_APP_ID && process.env.ALGOLIA_ADMIN_KEY) {
  try {
    client = algoliasearch(
      process.env.ALGOLIA_APP_ID,
      process.env.ALGOLIA_ADMIN_KEY,
    );
  } catch (error) {
    algoliaLogger.error("Failed to initialize Algolia client", {
      error,
      indexName: algoliaIndexName,
    });
  }
} else {
  algoliaLogger.warn("Algolia sync is disabled because credentials are missing", {
    hasAppId: Boolean(process.env.ALGOLIA_APP_ID),
    hasAdminKey: Boolean(process.env.ALGOLIA_ADMIN_KEY),
    indexName: algoliaIndexName,
  });
}

const isAlgoliaConfigured = Boolean(client);

const ensureClient = () => {
  if (!client) {
    throw new Error("Algolia client is not configured");
  }

  return client;
};

const toPlaceSearchRecord = (place) => ({
  objectID: place._id.toString(),
  title: place.title,
  description: place.description,
  address: place.address,
  image: place.image,
  vibe: place.vibe,
  _geoloc: {
    lat: place.location_geo.coordinates[1],
    lng: place.location_geo.coordinates[0],
  },
});

const savePlaceRecord = async (place) => {
  const algoliaClient = ensureClient();
  await algoliaClient.saveObjects({
    indexName: algoliaIndexName,
    objects: [toPlaceSearchRecord(place)],
  });
};

const updatePlaceRecord = async (placeId, attributes) => {
  const algoliaClient = ensureClient();
  await algoliaClient.partialUpdateObjects({
    indexName: algoliaIndexName,
    createIfNotExists: true,
    objects: [
      {
        objectID: placeId,
        ...attributes,
      },
    ],
  });
};

const deletePlaceRecord = async (placeId) => {
  const algoliaClient = ensureClient();
  await algoliaClient.deleteObject({
    indexName: algoliaIndexName,
    objectID: placeId,
  });
};

export {
  algoliaIndexName,
  deletePlaceRecord,
  isAlgoliaConfigured,
  savePlaceRecord,
  updatePlaceRecord,
};
