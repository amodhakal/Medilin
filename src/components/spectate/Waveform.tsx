/**
 * The speaking indicator.
 *
 * Previously an inline `[...Array(8)]` loop in each of the two agent cards,
 * indexing `[25, 45, 30, 50, 35]`. The array had five entries and the loop ran
 * eight times, so bars 5, 6, and 7 were handed `undefined`: the template
 * string produced `height: "undefined px"`, which the browser discards, and
 * three of the eight bars sat flat on the floor of the animation while the
 * other five moved. The bug was in both cards, so the wrongness was
 * symmetrical and therefore not obvious.
 *
 * Typed as a tuple so the loop and the heights have to agree at compile time
 * the next time someone changes one of them. That is a real improvement, but
 * it is not a guarantee: a tuple is erased at runtime, `noUncheckedIndexedAccess`
 * is not enabled in this project, so `HEIGHTS[i]` is typed as a number whether
 * or not it is one. The runtime guard in `waveBarHeight` is what actually
 * keeps the two in step, and it is here so that flipping that flag is a
 * tightening rather than the thing that finally notices.
 */

/** Bar heights in px. Exactly `WAVE_BAR_COUNT` of them, deliberately. */
export const WAVE_BAR_HEIGHTS = [10, 24, 34, 18, 30, 40, 22, 14] as const;

export const WAVE_BAR_COUNT = 8;

/**
 * Height for bar `index`, wrapping if the loop is ever widened.
 *
 * `% WAVE_BAR_COUNT` keeps a longer loop symmetric rather than trailing off,
 * and a non-number read comes back as 0, which renders as a flat bar instead
 * of a broken style attribute.
 */
export function waveBarHeight(index: number): number {
  const wrapped = ((index % WAVE_BAR_COUNT) + WAVE_BAR_COUNT) % WAVE_BAR_COUNT;
  const height = WAVE_BAR_HEIGHTS[wrapped];
  return typeof height === "number" ? height : 0;
}

export function Waveform({ barClassName }: { barClassName: string }) {
  return (
    <div className="mt-5 flex items-center justify-center gap-1.5 h-11" aria-hidden="true">
      {Array.from({ length: WAVE_BAR_COUNT }, (_, index) => (
        <div
          key={index}
          className={`w-1.5 rounded-full wave-bar ${barClassName}`}
          style={{
            height: `${waveBarHeight(index)}px`,
            animationDelay: `${(index * 0.1).toFixed(2)}s`,
          }}
        />
      ))}
    </div>
  );
}
