/** Announces flow progress to screen readers.
 *
 * A signing flow's steps (uploading, building, awaiting signature in
 * Freighter, submitting) otherwise show up only as new text on a disabled
 * button, which assistive technology does not announce. This component is a
 * polite live region carrying the same text the button shows.
 *
 * Render it unconditionally — with empty text when nothing is happening — so
 * the region is in the DOM before the first message; a live region added at
 * the same time as its first message is not announced reliably (#330).
 */
export function LiveStatus({ message }: { message: string }) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {message}
    </p>
  );
}
