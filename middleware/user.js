/**
 * Resolve Mongo user id from JWT payload.
 * Returns null if unsigned / AUTH_REQUIRED=false without id.
 */
export function resolveUserId(req) {
  const id = req?.user?.id;
  if (id && typeof id === "string" && id.length >= 12) return id;
  return null;
}

export function requireUserId(req) {
  const id = resolveUserId(req);
  if (!id) {
    throw Object.assign(
      new Error("Sign in required to use chat history"),
      { status: 401 }
    );
  }
  return id;
}
