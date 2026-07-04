import "dotenv/config";
import express from "express";
import mongoose from "mongoose";
import z from "zod/v4";
import { UserModel } from "./models/user.js";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";
import { checkUserAuth } from "./utils.js";

try {
  await mongoose.connect(process.env.MONGO_URI!);
  console.log("MongoDB connected");
} catch (error) {
  console.error("Failed to connect to MongoDB", error);
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(cookieParser());

app.get("/", (req, res) => {
  res.json({ msg: "Hello world" });
});

app.post("/auth/register", async (req, res) => {
  const schema = z.object({
    name: z.string().min(3),
    email: z.email(),
    password: z.string().min(6).max(20),
  });
  const result = schema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      msg: "Malformed input",
    });
  }

  const isExisting = await UserModel.findOne({
    email: result.data?.email,
  });

  if (isExisting) {
    res.status(400).json({
      msg: "User already exists",
    });
  }

  const hashedPassword = await argon2.hash(result.data?.password!);
  const user = await UserModel.create({
    ...result.data,
    password: hashedPassword,
  });

  const token = jwt.sign({ user_id: user.id }, process.env.JWT_SECRET!, {
    expiresIn: "7d",
  });
  res.cookie("user_auth", token, {
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 1 week
    httpOnly: true,
    sameSite: process.env.ENV === "production" ? "none" : "lax",
    secure: process.env.ENV === "production",
  });

  res.json({
    msg: "User created and logged in successfully",
  });
});

app.post("/auth/login", async (req, res) => {
  const schema = z.object({
    email: z.email(),
    password: z.string().min(6),
  });
  const result = schema.safeParse(req.body);

  if (!result.success) {
    res.status(400).json({
      msg: "Malformed input",
    });
  }

  const user = await UserModel.findOne({
    email: result.data?.email,
  });

  if (!user) {
    res.status(400).json({
      msg: "User not found",
    });
  }

  const isValidPassword = await argon2.verify(
    user?.password!,
    result.data?.password!,
  );

  if (!isValidPassword) {
    res.status(400).json({
      msg: "Invalid credentials",
    });
  }

  const token = jwt.sign({ user_id: user?.id }, process.env.JWT_SECRET!, {
    expiresIn: "7d",
  });
  res.cookie("user_auth", token, {
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 1 week
    httpOnly: true,
    sameSite: process.env.ENV === "production" ? "none" : "lax",
    secure: process.env.ENV === "production",
  });

  res.json({
    msg: "Logged in successfully",
  });
});

app.get("/auth/me", async (req, res) => {
  const token = req.cookies.user_auth;
  const { isValid, user } = await checkUserAuth(token);
  if (!isValid) {
    res.status(400).json({
      msg: "Invalid token",
    });
  }

  if (!user) {
    res.status(400).json({
      msg: "User not found",
    });
  }

  res.json({
    userName: user?.name,
    userId: user?._id,
  });
});

app.post("/auth/logout", async (req, res) => {
  res.clearCookie("user_auth");
  res.json({
    msg: "Logged out successfully",
  });
});

app.listen(process.env.PORT || 3000);
console.log("Listening on http://localhost:3000");
