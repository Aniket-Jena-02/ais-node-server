import "dotenv/config";
import express from "express";
import mongoose from "mongoose";

try {
  await mongoose.connect(process.env.MONGO_URI!);
  console.log("MongoDB connected");
} catch (error) {
  console.error("Failed to connect to MongoDB", error);
  process.exit(1);
}

const app = express();

app.get("/", (req, res) => {
  res.json({ msg: "Hello world" });
});

app.listen(process.env.PORT || 3000);
console.log("Listening on http://localhost:3000");
