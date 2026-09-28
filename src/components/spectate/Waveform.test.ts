import { describe, expect, test } from "bun:test";
import { WAVE_BAR_COUNT, WAVE_BAR_HEIGHTS, waveBarHeight } from "./Waveform";

/**
 * The waveform bug from #46, pinned.
 *
 * The render loop was `[...Array(8)]` indexing a five-entry array, so bars 5,
 * 6, and 7 got `height: "undefined px"`. A style the browser discards, three
 * times, in both agent cards. The count and the heights now have to agree, and
 * these are the assertions that notice if they stop agreeing.
 */
describe("waveBarHeight", () => {
  test("returns a real number for every bar the component renders", () => {
    for (let index = 0; index < WAVE_BAR_COUNT; index += 1) {
      const height = waveBarHeight(index);
      expect(typeof height).toBe("number");
      expect(Number.isFinite(height)).toBe(true);
      expect(height).toBeGreaterThan(0);
    }
  });

  test("covers every entry in the table, so no bar is left flat", () => {
    const rendered = Array.from({ length: WAVE_BAR_COUNT }, (_, i) => waveBarHeight(i));
    expect(rendered).toEqual([...WAVE_BAR_HEIGHTS]);
  });

  test("the table is exactly as long as the loop that reads it", () => {
    // The whole regression in one line: five heights, eight bars.
    expect(WAVE_BAR_HEIGHTS).toHaveLength(WAVE_BAR_COUNT);
  });

  test("never yields a value that would stringify to 'undefined px'", () => {
    for (let index = 0; index < WAVE_BAR_COUNT; index += 1) {
      expect(`${waveBarHeight(index)}px`).not.toBe("undefined px");
    }
  });

  test("wraps rather than running off the end of the table", () => {
    expect(waveBarHeight(WAVE_BAR_COUNT)).toBe(waveBarHeight(0));
    expect(waveBarHeight(WAVE_BAR_COUNT + 3)).toBe(waveBarHeight(3));
  });

  test("treats a negative index as a wrapped one, not as undefined", () => {
    expect(waveBarHeight(-1)).toBe(waveBarHeight(WAVE_BAR_COUNT - 1));
  });
});
