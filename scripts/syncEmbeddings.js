import dotenv from "dotenv";
import mongoose from "mongoose";
import Place from "../models/place.js";
import { generateEmbedding } from "../services/gemini-service.js";

dotenv.config();

const syncEmbeddings = async () => {
  console.log("Connecting to MongoDB...");
  await mongoose.connect(
    `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASSWORD}@cluster0.j4rbbcm.mongodb.net/${process.env.DB_NAME}?retryWrites=true&w=majority`
  );

  console.log("Connected to MongoDB.");

  // Find all places that don't have embeddings yet
  const places = await Place.find({
    $or: [
      { embedding: { $exists: false } },
      { embedding: { $size: 0 } },
      { embedding: null },
    ],
  });

  console.log(`Found ${places.length} places without embeddings.`);

  let successCount = 0;
  for (let i = 0; i < places.length; i++) {
    const p = places[i];
    console.log(`[${i + 1}/${places.length}] Embedding: "${p.title}"...`);

    try {
      const text = `${p.title}. ${p.description}. Located at: ${p.address}`;
      const vector = await generateEmbedding(text);
      p.embedding = vector;
      await p.save();
      successCount++;
      console.log(`  -> Saved embedding (dim: ${vector.length})`);
      // Gentle pause to avoid rate limits
      await new Promise((r) => setTimeout(r, 400));
    } catch (err) {
      console.error(`  -> Failed for "${p.title}":`, err.message);
    }
  }

  console.log(`\nSynchronization complete! Updated ${successCount}/${places.length} places.`);
  await mongoose.disconnect();
};

syncEmbeddings().catch((err) => {
  console.error("Migration error:", err);
  process.exit(1);
});
