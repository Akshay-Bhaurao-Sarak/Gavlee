const mongoose = require("mongoose");
const initData = require("./data.js");
const Listing = require("../models/listing.js");

const MONGO_URL = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/gavlee";

async function initDB() {
    try {
        await mongoose.connect(MONGO_URL);
        const operations = initData.data.map(listing => ({
            updateOne: {
                filter: { title: listing.title },
                update: { $set: listing },
                upsert: true,
            },
        }));
        const result = await Listing.bulkWrite(operations);
        console.log(`Loaded ${initData.data.length} listings (${result.upsertedCount} inserted, ${result.modifiedCount} updated).`);
    } catch (err) {
        console.error("Could not load listing data:", err);
        process.exitCode = 1;
    } finally {
        await mongoose.disconnect();
    }
}

initDB();
