import express from "express";
import z from "zod";

import { auth, upload } from "../middlewares.js";

import { LastReadModel } from "../models/lastRead.js";
import { MessageModel } from "../models/message.js";
import { ChannelModel } from "../models/channel.js";
import { upsertLastRead } from "../utils.js";
import { UserModel } from "../models/user.js";
import { onlineUsersList } from "../socket.js";
import { io } from "../socket.js";
import sharp from "sharp";
import path from "node:path";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";

const channelRouter = express.Router();

channelRouter.post("/create-channel", auth, async (req, res) => {
  const schema = z.object({
    name: z.string().min(3).max(20),
  });

  const result = schema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      msg: "Malformed input",
    });
  }

  const channel = await ChannelModel.create({
    name: result.data.name,
    admin: req.user?.id,
    members: [req.user!.id],
  });

  return res.json({
    msg: "Channel created",
    channelId: channel._id,
  });
});

channelRouter.get("/user", auth, async (req, res) => {
  const userId = req.user.id;
  const channels = await ChannelModel.find({
    members: userId,
  })
    .select({
      name: 1,
      createdAt: 1,
    })
    .lean();

  if (channels.length === 0) return res.json([]);

  const channelIds = channels.map((c) => c._id);

  const lastReads = await LastReadModel.find({
    userId: req.user?.id,
    channelId: { $in: channelIds },
  })
    .select({
      channelId: 1,
      lastReadMessageId: 1,
    })
    .lean();

  const lastReadByChannel = new Map(
    lastReads.map((lr) => [
      lr.channelId.toString(),
      lr.lastReadMessageId?.toString() ?? null,
    ]),
  );

  const unreadCounts = await MessageModel.aggregate([
    {
      $match: {
        $or: channels.map((c) => {
          const lastReadId = lastReadByChannel.get(c._id.toString());
          return {
            channelId: c._id,
            ...(lastReadId ? { _id: { $gt: lastReadId } } : {}),
          };
        }),
      },
    },
    { $group: { _id: "$channelId", count: { $sum: 1 } } },
  ]);

  const unreadByChannel = new Map(
    unreadCounts.map((u) => [u._id.toString(), u.count]),
  );

  const result = channels.map((channel) => ({
    ...channel,
    unreadCount: unreadByChannel.get(channel._id.toString()) ?? 0,
  }));

  return res.json(result);
});

channelRouter.get("/:id/messages", auth, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id as string;
  const before = req.query.before as string;
  const limit = Math.min(
    parseInt((req.query.limit as string) || "50", 10),
    100,
  );

  const isMember = await ChannelModel.exists({
    _id: id,
    members: userId,
  });
  if (!isMember) {
    return res.status(403).json({
      msg: "User not authorized to view this channel",
    });
  }

  const query: Record<string, any> = { channelId: id };
  if (before) {
    query._id = { $lt: before };
  }

  const messages = await MessageModel.find(query)
    .sort({ _id: -1 })
    .limit(limit)
    .populate("author", "name")
    .populate({
      path: "replyTo",
      select: "content author",
      populate: { path: "author", select: "name" },
    })
    .select({
      content: 1,
      createdAt: 1,
      isEdited: 1,
      reactions: 1,
      replyTo: 1,
      file: 1,
    });

  messages.reverse();

  if (!before && messages.length > 0) {
    const latestVisibleMessage = messages[messages.length - 1];
    await upsertLastRead(
      userId.toString(),
      id,
      latestVisibleMessage._id.toString(),
    );
  }

  return res.json({
    messages,
    hasMore: messages.length === limit,
  });
});

channelRouter.get("/:id", auth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  const isMember = await ChannelModel.exists({
    _id: id,
    members: userId,
  });
  if (!isMember) {
    return res.status(403).json({
      msg: "User not authorized to view this channel",
    });
  }

  const channel = await ChannelModel.findById(id)
    .populate("members", "name")
    .select({
      name: 1,
      createdAt: 1,
      admin: 1,
    });

  if (!channel) {
    return res.status(404).json({
      msg: "Channel not found",
    });
  }

  return res.json({
    channel,
    isAdmin: channel.admin && channel.admin?.toString() === userId.toString(),
  });
});

channelRouter.post("/:id/read", auth, async (req, res) => {
  const userId = req.user.id;
  const id = req.params.id as string;

  const isMember = await ChannelModel.exists({
    _id: id,
    members: userId,
  });
  if (!isMember) {
    return res.status(403).json({
      msg: "User not authorized to view this channel",
    });
  }

  const schema = z.object({
    messageId: z.string().optional(),
  });
  const result = schema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      msg: "Malformed input",
    });
  }

  let messageId = result.data.messageId;
  if (messageId) {
    const messageExists = await MessageModel.exists({
      _id: messageId,
      channelId: id,
    });
    if (!messageExists) {
      return res.status(404).json({
        msg: "Message not found",
      });
    }
  } else {
    const latestMessage = await MessageModel.findOne({ channelId: id })
      .sort({ _id: -1 })
      .select({ _id: 1 })
      .lean();

    messageId = latestMessage?._id?.toString();
  }

  await upsertLastRead(userId.toString(), id, messageId);

  return res.json({
    msg: "Channel marked as read",
    lastReadMessageId: messageId ?? null,
  });
});

channelRouter.post("/:id/add-member", auth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  const selectedChannel = await ChannelModel.findById(id);

  if (!selectedChannel) {
    return res.status(404).json({
      msg: "Channel not found",
    });
  }

  if (selectedChannel.admin?.toString() !== userId.toString()) {
    return res.status(403).json({
      msg: "User not authorized to add members",
    });
  }

  const schema = z.object({
    email: z.email(),
  });
  const result = schema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      msg: "Malformed input",
    });
  }

  const userToAdd = await UserModel.findOne({
    email: result.data.email,
  });

  if (!userToAdd) {
    return res.status(404).json({
      msg: "User not found",
    });
  }

  const updateResult = await ChannelModel.updateOne(
    { _id: id },
    { $addToSet: { members: userToAdd._id } },
  );

  if (updateResult.modifiedCount === 0) {
    return res.status(400).json({
      msg: "User already a member",
    });
  }

  return res.json({
    msg: "User added to channel",
  });
});

channelRouter.get("/:id/members", auth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  const isMember = await ChannelModel.exists({
    _id: id,
    members: userId,
  });
  if (!isMember) {
    return res.status(403).json({
      msg: "User not authorized to view this channel",
    });
  }

  const channel = await ChannelModel.findById(id)
    .populate("members", "name")
    .select({
      members: 1,
      admin: 1,
    });

  if (!channel) {
    return res.status(404).json({
      msg: "Channel not found",
    });
  }

  const formattedMembers = channel.members.map((member: any) => ({
    _id: member._id,
    name: member.name,
    status: onlineUsersList.has(member._id.toString()) ? "online" : "offline",
    role:
      channel.admin?.toString() === member._id.toString() ? "admin" : "member",
  }));

  formattedMembers.sort((a, b) => {
    if (a.status !== b.status) {
      return a.status === "online" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return res.json(formattedMembers);
});

channelRouter.patch("/messages/:msgId", auth, async (req, res) => {
  const userId = req.user.id;
  const { msgId } = req.params;

  const message = await MessageModel.findById(msgId);

  if (!message) {
    return res.status(404).json({
      msg: "Message not found",
    });
  }

  if (message.author?.toString() !== userId.toString()) {
    return res.status(403).json({
      msg: "User not authorized to edit this message",
    });
  }

  const EDIT_WINDOW_MS = 15 * 60 * 1000;
  const elapsed = Date.now() - new Date(message.createdAt).getTime();
  if (elapsed > EDIT_WINDOW_MS) {
    return res.status(403).json({
      msg: "Message can no longer be edited — edit window has expired",
    });
  }

  const schema = z.object({
    content: z.string().min(1).max(1000),
  });
  const result = schema.safeParse(req.body);

  if (!result.success) {
    return res.status(400).json({
      msg: "Malformed input",
    });
  }

  message.content = result.data.content;
  message.set("isEdited", true);
  await message.save();

  if (message.channelId) {
    io.to(message.channelId.toString()).emit("message_edited", {
      messageId: msgId,
      content: message.content,
      isEdited: true,
    });
  }

  return res.json({
    msg: "Message edited successfully",
    content: message.content,
    isEdited: true,
  });
});

channelRouter.delete("/messages/:msgId", auth, async (req, res) => {
  const userId = req.user.id;
  const { msgId } = req.params;

  const message = await MessageModel.findById(msgId);

  if (!message) {
    return res.status(404).json({
      msg: "Message not found",
    });
  }

  const channel = await ChannelModel.findById(message.channelId);

  if (!channel) {
    return res.status(404).json({
      msg: "Channel not found",
    });
  }

  const isChannelAdmin = channel.admin?.toString() === userId.toString();

  if (message.author?.toString() !== userId.toString() && !isChannelAdmin) {
    return res.status(403).json({
      msg: "User not authorized to delete this message",
    });
  }

  await message.deleteOne();

  if (message.channelId) {
    io.to(message.channelId.toString()).emit("message_deleted", {
      messageId: msgId,
    });
  }

  return res.json({
    msg: "Message deleted successfully",
  });
});

channelRouter.post("/:id/leave", auth, async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;

  const channel = await ChannelModel.findById(id);
  if (!channel) {
    return res.status(404).json({ msg: "Channel not found" });
  }

  if (channel.admin?.toString() === userId.toString()) {
    return res.status(400).json({
      msg: "Channel admin cannot leave. Transfer ownership or delete the channel.",
    });
  }

  const isMember = channel.members.some(
    (m: any) => m.toString() === userId.toString(),
  );
  if (!isMember) {
    return res
      .status(400)
      .json({ msg: "You are not a member of this channel" });
  }

  channel.members = channel.members.filter(
    (m: any) => m.toString() !== userId.toString(),
  ) as any;
  await channel.save();
  await LastReadModel.deleteOne({ userId, channelId: id });

  return res.json({ msg: "Left channel successfully" });
});

channelRouter.delete("/:id/members/:memberId", auth, async (req, res) => {
  const userId = req.user.id;
  const { id, memberId } = req.params;

  const channel = await ChannelModel.findById(id);
  if (!channel) {
    return res.status(404).json({ msg: "Channel not found" });
  }

  if (channel.admin?.toString() !== userId.toString()) {
    return res.status(400).json({
      msg: "You are not the channel admin. Only the admin can remove members.",
    });
  }

  if(userId === memberId) {
    return res.status(400).json({
      msg: "You cannot remove yourself from the channel.",
    });
  }

  const isMember = channel.members.some(
    (m: any) => m.toString() === memberId.toString(),
  );
  if (!isMember) {
    return res
      .status(404)
      .json({ msg: "Member not found in this channel" });
  }

  channel.members = channel.members.filter(
    (m: any) => m.toString() !== memberId.toString(),
  ) as any;
  await channel.save();
  await LastReadModel.deleteOne({ userId: memberId, channelId: id });

  // Notify the member that they have been removed
  io.to(memberId).emit("member_removed", { msg: "You have been removed from the channel." });

  return res.json({ msg: "Member removed successfully" });
});

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
]);

channelRouter.post("/:id/upload", auth, upload.single("file"), async (req, res) => {
  const userId = req.user.id;
  const { id } = req.params;
  const file = req.file

  const isMember = await ChannelModel.exists({
    _id: id,
    members: userId
  })

  if (!file) {
      return res.status(400).json({ msg: "No file uploaded" });
  }

  if (!isMember) {
    return res.status(403).json({ msg: "You are not a member of this channel" });
  }

  const uploadedFileSchema = z.object({
    mimetype: z.enum([...ALLOWED_MIME_TYPES] as [string, ...string[]], {
      message: "Invalid file type",
    }),
    size: z
      .number()
      .min(1, "File size is too small")
      .max(MAX_FILE_SIZE, "File size must not exceed 10MB"),
    path: z.string(),
  });
  const result = uploadedFileSchema.safeParse(file);

  await fs.mkdir(UPLOAD_DIR, { recursive: true });

      let finalName: string;
      let finalMimeType: string;

      if (file.mimetype.startsWith("image/")) {
        finalName = `${randomUUID()}.webp`;
        finalMimeType = "image/webp";
        await sharp(file.path).webp({ quality: 82 }).toFile(path.join(UPLOAD_DIR, finalName));
        await fs.unlink(file.path);
      } else if (file.mimetype === "application/pdf") {
        finalName = `${randomUUID()}.pdf`;
        finalMimeType = "application/pdf";
        await fs.rename(file.path, path.join(UPLOAD_DIR, finalName));
      } else {
        await fs.unlink(file.path).catch(() => {});
        return res.status(400).json({ msg: "Unsupported file type" });
      }

      return res.json({
        msg: "File uploaded successfully",
          size: file.size,
          type: finalMimeType,
          name: file.originalname,
          url: `/uploads/${finalName}`,
      });
});

export default channelRouter;
