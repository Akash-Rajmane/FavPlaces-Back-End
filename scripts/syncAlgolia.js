import mongoose from "mongoose";
import dotenv from "dotenv";
import Place from "../models/place.js";
import { algoliasearch } from "algoliasearch";

dotenv.config();

// 🔥 Connect Mongo manually
await mongoose.connect(
  `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.j4rbbcm.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority`
);

console.log("Mongo connected for sync ✅");

console.log("MongoDB Connected ✅");

const client = algoliasearch(
  process.env.ALGOLIA_APP_ID,
  process.env.ALGOLIA_ADMIN_KEY
);

const syncPlaces = async () => {
  const places = await Place.find().lean({ virtuals: true });

  const formatted = places.map((place) => ({
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
  }));

  await client.saveObjects({
    indexName: "places",
    objects: formatted,
  });

  console.log("Synced successfully ✅");
};

syncPlaces();
