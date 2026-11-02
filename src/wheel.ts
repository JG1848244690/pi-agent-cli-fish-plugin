/**
 * Wheel events are not one-per-notch everywhere.
 *
 * Orca's built-in terminal measures the pixel delta of a physical notch and
 * replays it as several synthetic wheel reports (one per text row, see its
 * `attachCustomWheelEventHandler`). Pi then receives those reports back to back
 * and every view here pages once per report, so a single notch moves several
 * lines (or flips several pages) while the same wheel in cmd moves exactly one.
 *
 * Reports from one notch are dispatched in the same tick, so dropping a report
 * that repeats the previous direction within a few milliseconds keeps one step
 * per notch. Real fast scrolling is slower than that: a physical notch is tens
 * of milliseconds apart even when the wheel is spun quickly.
 */

/** Reports closer than this belong to one physical notch. */
const BURST_MS = 5;

export class WheelBurst {
  private lastAt = Number.NEGATIVE_INFINITY;
  private lastDirection = 0;

  /**
   * True when this report is an extra event from the notch that produced the
   * previous one, i.e. it should be consumed without paging again.
   *
   * The window is measured from the report that paged, not from the last
   * duplicate, so a long burst cannot keep sliding the window forward and
   * block the next notch.
   */
  duplicate(direction: 1 | -1, now = performance.now()): boolean {
    const duplicate = direction === this.lastDirection && now - this.lastAt < BURST_MS;
    if (!duplicate) {
      this.lastDirection = direction;
      this.lastAt = now;
    }
    return duplicate;
  }
}
