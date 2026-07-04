import mongoose from "mongoose";

const UserMongoSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    password: String,
  },
  {
    timestamps: true,
    autoIndex: true,
  },
);

export const UserModel = mongoose.model("User", UserMongoSchema);
