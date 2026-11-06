/**
 * Integration point for access-control hardware (turnstiles, door controllers, biometric
 * readers). Out of scope for v1 (D-09, D-15): nothing implements this yet. A hardware adapter
 * would read a pass code (or a card number mapped to a pass), call validateScan with a
 * registered ScanDevice id, and open the gate only on an ACCEPTED result.
 */
export type AccessDecision = {
  open: boolean;
  /** Plain-words reason for a display on the gate, if any. */
  message: string;
  eventId: string;
};

export interface AccessDevice {
  /** The ScanDevice this hardware is registered as (branch + name). */
  readonly deviceId: string;
  /** Called by the adapter when the reader sees a code; must not open on anything but `open`. */
  onCode(payload: string): Promise<AccessDecision>;
  /** Pulse the relay / unlock for a short time. */
  open(durationMs: number): Promise<void>;
}
