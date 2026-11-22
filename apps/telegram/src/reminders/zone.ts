import { parseDefaultTz } from "@workspace/env/bot";
import { Result } from "effect";

/**
 * A zone the owner typed, in its canonical spelling, or undefined. Takes what
 * boot takes for `DEFAULT_TZ` (`Europe/Sofia`, `UTC`, any case), plus a bare
 * city when exactly one known zone ends in it (`Sofia`, `new york`).
 */
export const resolveZone = (input: string) => {
  const typed = input.trim().replaceAll(/\s+/gu, "_");
  // Blank is the fallback zone to boot; here it is no answer at all.
  const parsed =
    typed.length === 0 ? Result.fail("blank") : parseDefaultTz(typed);
  if (Result.isSuccess(parsed)) {
    return Intl.DateTimeFormat("en-US", {
      timeZone: parsed.success,
    }).resolvedOptions().timeZone;
  }
  const city = typed.toLowerCase();
  const matches = typed.includes("/")
    ? []
    : Intl.supportedValuesOf("timeZone").filter(
        (zone) => zone.split("/").at(-1)?.toLowerCase() === city
      );
  return matches.length === 1 ? matches[0] : undefined;
};
