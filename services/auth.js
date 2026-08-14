import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";

import {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  JWT_SECRET,
  JWT_EXPIRES_IN,
} from "../config.js";

function getOAuthClient(redirectUri = GOOGLE_REDIRECT_URI) {
  if (!GOOGLE_CLIENT_ID) {
    throw Object.assign(new Error("GOOGLE_CLIENT_ID is not configured"), {
      status: 500,
    });
  }
  return new OAuth2Client(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET || undefined,
    redirectUri || undefined
  );
}

function assertJwtSecret() {
  if (!JWT_SECRET) {
    throw Object.assign(new Error("JWT_SECRET is not configured"), {
      status: 500,
    });
  }
}

function userFromGooglePayload(payload) {
  return {
    sub: payload.sub,
    email: payload.email || null,
    emailVerified: Boolean(payload.email_verified),
    name: payload.name || null,
    picture: payload.picture || null,
  };
}

/** Verify Google ID token from GIS Sign-In / One Tap (`credential`). */
export async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== "string") {
    throw Object.assign(new Error("Missing Google idToken"), { status: 400 });
  }
  const client = getOAuthClient();
  const ticket = await client.verifyIdToken({
    idToken,
    audience: GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.sub) {
    throw Object.assign(new Error("Invalid Google token payload"), {
      status: 401,
    });
  }
  return userFromGooglePayload(payload);
}

/**
 * Exchange OAuth 2.0 authorization code for tokens, then verify id_token.
 * Used when the frontend sends `code` from Google's auth code flow.
 */
export async function verifyGoogleAuthCode(code, redirectUri) {
  if (!code || typeof code !== "string") {
    throw Object.assign(new Error("Missing Google authorization code"), {
      status: 400,
    });
  }
  if (!GOOGLE_CLIENT_SECRET) {
    throw Object.assign(
      new Error("GOOGLE_CLIENT_SECRET is required for auth-code sign-in"),
      { status: 500 }
    );
  }
  const client = getOAuthClient(redirectUri || GOOGLE_REDIRECT_URI);
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) {
    throw Object.assign(new Error("Google did not return an id_token"), {
      status: 401,
    });
  }
  return verifyGoogleIdToken(tokens.id_token);
}

/** Issue app JWT (stateless — no Passport / no server session). */
export function signAppJwt(user) {
  assertJwtSecret();
  const payload = {
    sub: user.sub || user.googleId,
    id: user.id || null,
    email: user.email,
    name: user.name,
    picture: user.picture,
  };
  const token = jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
    issuer: "rag-api",
    audience: "rag-frontend",
  });
  return token;
}

export function verifyAppJwt(token) {
  assertJwtSecret();
  if (!token || typeof token !== "string") {
    throw Object.assign(new Error("Missing bearer token"), { status: 401 });
  }
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      issuer: "rag-api",
      audience: "rag-frontend",
    });
    return {
      id: decoded.id || null,
      sub: decoded.sub,
      email: decoded.email || null,
      name: decoded.name || null,
      picture: decoded.picture || null,
    };
  } catch {
    throw Object.assign(new Error("Invalid or expired token"), { status: 401 });
  }
}

export function buildGoogleAuthUrl({ state, redirectUri } = {}) {
  const client = getOAuthClient(redirectUri || GOOGLE_REDIRECT_URI);
  return client.generateAuthUrl({
    access_type: "offline",
    prompt: "select_account",
    scope: ["openid", "email", "profile"],
    state: state || undefined,
  });
}
