import mongoose from "mongoose";

const ChannelMongoSchema = new mongoose.Schema(
  {
    name: String,
    messages: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Message",
      },
    ],
    members: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "User",
        index: true,
      },
    ],
    admin: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  {
    timestamps: true,
    autoIndex: true,
  },
);

export const ChannelModel = mongoose.model("Channel", ChannelMongoSchema);
