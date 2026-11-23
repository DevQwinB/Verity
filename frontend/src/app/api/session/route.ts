import { NextResponse } from "next/server";
import { sessionInfo } from "../../../lib/backend-proxy";

/** Lets client components ask "am I logged in, as whom, and until when"
 * without ever reading the httpOnly JWT cookie themselves - this route reads
 * it server-side and returns only the non-secret account id and the token's
 * `exp`. Both are unverified claims: the backend still verifies the token on
 * every call, so the dashboard uses them for display and for its expiry
 * clock, never for authorisation. `expires_at` is in milliseconds since the
 * epoch, or null when the token has no `exp`. */
export async function GET() {
  const { account, expires_at } = await sessionInfo();
  return NextResponse.json({ account, expires_at });
}
