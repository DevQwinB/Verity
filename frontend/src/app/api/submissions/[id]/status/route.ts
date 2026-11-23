import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { backendGetOrNull } from "../../../../../lib/server-api";
import type { SubmissionDetail } from "../../../../../lib/types";

/** A small fingerprint of the parts of a submission that change while a page
 * is polling it. AutoRefresh compares it with the previous answer and only
 * asks Next to re-render the page when something moved, so an unchanged poll
 * is one small request and no RSC render. A failure here is a plain non-2xx:
 * the client keeps the last good page and backs off, instead of a failed
 * background read reaching app/error.tsx and replacing the page. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const detail = await backendGetOrNull<SubmissionDetail>(`/v1/submissions/${id}`);
    if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
    const { submission, replays, challenge } = detail;
    return NextResponse.json({
      status: submission.status,
      settled_at: submission.settled_at,
      updated_at: submission.updated_at,
      challenge_id: challenge?.id ?? null,
      replays_confirmed: replays.filter((r) => r.status === "confirmed_onchain").length,
    });
  } catch (err) {
    // Let Next's own control-flow errors (dynamic rendering, redirects) pass.
    unstable_rethrow(err);
    console.error(`submission status: ${id} could not be read`, err);
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
