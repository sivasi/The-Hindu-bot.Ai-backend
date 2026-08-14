import { User } from "../models/User.js";
import { isMongoConfigured, isMongoReady, connectMongo } from "./mongo.js";

export function toPublicUser(doc) {
  if (!doc) return null;
  return {
    id: String(doc._id),
    sub: doc.googleId,
    googleId: doc.googleId,
    email: doc.email || null,
    emailVerified: Boolean(doc.emailVerified),
    name: doc.name || null,
    picture: doc.picture || null,
    provider: doc.provider || "google",
    loginCount: doc.loginCount || 1,
    lastLoginAt: doc.lastLoginAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null,
  };
}

/**
 * On Google sign-in: create user if new, otherwise update profile + lastLoginAt.
 * Returns { user, created }.
 */
export async function upsertUserFromGoogle(googleUser) {
  if (!googleUser?.sub) {
    throw Object.assign(new Error("Invalid Google user (missing sub)"), {
      status: 400,
    });
  }
  if (!googleUser.email) {
    throw Object.assign(new Error("Google account email is required"), {
      status: 400,
    });
  }

  if (!isMongoConfigured()) {
    // Fallback when Mongo is not configured — still allow JWT sign-in.
    return {
      created: false,
      user: {
        id: null,
        sub: googleUser.sub,
        googleId: googleUser.sub,
        email: googleUser.email,
        emailVerified: Boolean(googleUser.emailVerified),
        name: googleUser.name || null,
        picture: googleUser.picture || null,
        provider: "google",
        loginCount: 1,
        lastLoginAt: new Date().toISOString(),
        createdAt: null,
        updatedAt: null,
      },
    };
  }

  if (!isMongoReady()) {
    await connectMongo();
  }

  const existing = await User.findOne({ googleId: googleUser.sub });
  if (!existing) {
    const created = await User.create({
      googleId: googleUser.sub,
      email: googleUser.email,
      emailVerified: Boolean(googleUser.emailVerified),
      name: googleUser.name || null,
      picture: googleUser.picture || null,
      provider: "google",
      lastLoginAt: new Date(),
      loginCount: 1,
    });
    return { created: true, user: toPublicUser(created) };
  }

  existing.email = googleUser.email;
  existing.emailVerified = Boolean(googleUser.emailVerified);
  existing.name = googleUser.name || existing.name;
  existing.picture = googleUser.picture || existing.picture;
  existing.lastLoginAt = new Date();
  existing.loginCount = (existing.loginCount || 0) + 1;
  await existing.save();

  return { created: false, user: toPublicUser(existing) };
}

export async function findUserByGoogleId(googleId) {
  if (!googleId || !isMongoConfigured()) return null;
  if (!isMongoReady()) await connectMongo();
  const doc = await User.findOne({ googleId });
  return toPublicUser(doc);
}

export async function findUserById(id) {
  if (!id || !isMongoConfigured()) return null;
  if (!isMongoReady()) await connectMongo();
  const doc = await User.findById(id);
  return toPublicUser(doc);
}
