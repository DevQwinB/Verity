import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "../../../lib/backend-proxy";

/** Lets client components ask "am I logged in, as whom" without ever
 * reading the httpOnly JWT cookie themselves - this route reads it
 * server-side and returns only the non-secret account id. */
export async function GET() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return NextResponse.json({ account: null });
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    if (payload.exp && Date.now() >= payload.exp * 1000) {
      return NextResponse.json({ account: null });
    }
    return NextResponse.json({ account: payload.sub as string });
  } catch {
    return NextResponse.json({ account: null });
  }
}
