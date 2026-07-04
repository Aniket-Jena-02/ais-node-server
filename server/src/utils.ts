import jwt, { JwtPayload } from "jsonwebtoken";
import { UserModel } from "./models/user.js";

export const checkUserAuth = async (token: string | undefined) => {
  if (!token) {
    return {
      isValid: false,
      user: null,
    };
  }

  interface Payload extends JwtPayload {
    user_id: string;
  }
  const payload = jwt.verify(token, process.env.JWT_SECRET!) as Payload;

  if (!payload) {
    return {
      isValid: false,
      user: null,
    };
  }

  let user;
  try {
    user = await UserModel.findById(payload.user_id);
  } catch (err) {
    console.error(err);
  }

  if (!user) {
    return {
      isValid: false,
      user: null,
    };
  }

  return {
    isValid: true,
    user,
  };
};
