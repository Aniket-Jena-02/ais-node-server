import { NextFunction, Request, Response } from "express";
import { checkUserAuth } from "./utils.js";
import multer from "multer";
import path from "node:path";
import { randomUUID } from "node:crypto";

export async function auth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies.user_auth;
  const { isValid, user } = await checkUserAuth(token);
  if (!isValid) {
    return res.status(400).json({
      msg: "Invalid token",
    });
  }

  if (!user) {
    return res.status(400).json({
      msg: "User not found",
    });
  }

  req.user = {
    id: user._id.toString(),
    name: user.name || "",
  };
  next();
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const upload = multer({
  dest: path.join(process.cwd(), "temp"),
  limits: { fileSize: MAX_FILE_SIZE },
});
