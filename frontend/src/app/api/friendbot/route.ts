import { NextResponse } from "next/server";
import { FRIENDBOT_URL } from "../../../lib/config";
import { sessionAccount } from "../../../lib/backend-proxy";

/**
 * Asks Stellar's testnet faucet (Friendbot) to fund the signed-in account.
 * A real request to the real faucet: it only ever funds the account that is
 * signed in, so this route cannot be used to drain the faucet toward
 * arbitrary addresses.
 */
export async function POST() {
  const account = await sessionAccount();
  if (!account) return NextResponse.json({ error: "not authenticated" }, { status: 401 });

  let res: Response;
  try {
    res = await fetch(`${FRIENDBOT_URL}/?addr=${encodeURIComponent(account)}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    return NextResponse.json({ error: "The testnet faucet did not respond. Try again shortly." }, { status: 502 });
  }
  if (res.ok) {
    return NextResponse.json({ funded: true, message: "Friendbot sent 10,000 test XLM to your account." });
  }
  // Friendbot funds an account once; asking again is answered with an error
  // that means "already has funds", which is fine for our purposes.
  const detail = await res.text().catch(() => "");
  if (/already funded|op_already_exists|createAccountAlreadyExist/i.test(detail)) {
    return NextResponse.json({ funded: false, message: "This account already has test XLM from Friendbot." });
  }
  return NextResponse.json({ error: "The testnet faucet declined the request. Try again shortly." }, { status: 502 });
}
