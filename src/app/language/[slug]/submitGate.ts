/**
 * At most one submission in flight.
 *
 * A submit button that is not disabled accepts a second click, and a second
 * click on a booking form is two bookings. The fix is a flag, and the reason
 * this is a module rather than a line in the component is that the obvious
 * version of the flag does not work: `useState` re-renders too late, so both
 * clicks of a double click read `pending === false` and both start a
 * submission. The flag has to be read and written synchronously, which in a
 * component means a ref.
 *
 * Kept as its own object so the rule can be tested without a browser, which is
 * the only way to test that the second call is refused.
 */
export interface SubmitGate {
  /** True if this caller may proceed. False if a submission is already open. */
  begin(): boolean;
  /** Releases the gate. Must run even when the submission throws. */
  end(): void;
  /** Whether a submission is currently open. For rendering, not for guarding. */
  readonly isOpen: boolean;
}

export function createSubmitGate(): SubmitGate {
  let open = false;

  return {
    begin(): boolean {
      if (open) return false;
      open = true;
      return true;
    },
    end(): void {
      open = false;
    },
    get isOpen(): boolean {
      return open;
    },
  };
}
