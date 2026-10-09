import { NextResponse } from "next/server";
import { sessionAccount } from "../../../lib/backend-proxy";

/** Lets client components ask "am I logged in, as whom" without ever
 * reading the httpOnly JWT cookie themselves - this route reads it
 * server-side and returns only the non-secret account id. */
export async function GET() {
  return NextResponse.json({ account: await sessionAccount() });
}
