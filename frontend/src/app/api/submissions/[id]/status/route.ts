import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { backendGetOrNull } from "../../../../../lib/server-api";
import { submissionFingerprint } from "../../../../../lib/submission-status";
import type { SubmissionDetail } from "../../../../../lib/types";

/** A small fingerprint of the parts of a submission that change while a page
 * is polling it. AutoRefresh compares it with the fingerprint the page was
 * rendered with and only asks Next to re-render when something moved, so an
 * unchanged poll is one small request and no RSC render. The page and this
 * route build the fingerprint with the same helper, and a failure here is a
 * plain non-2xx: the client keeps the last good page and backs off, instead of
 * a failed background read reaching app/error.tsx and replacing the page. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const detail = await backendGetOrNull<SubmissionDetail>(`/v1/submissions/${id}`);
    if (!detail) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ fingerprint: submissionFingerprint(detail) });
  } catch (err) {
    // Let Next's own control-flow errors (dynamic rendering, redirects) pass.
    unstable_rethrow(err);
    console.error(`submission status: ${id} could not be read`, err);
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  }
}
