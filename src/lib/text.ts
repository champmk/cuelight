// Mojibake repair: strings that were double-encoded (UTF-8 bytes re-read as
// Windows-1252) at some point get healed at load time, wherever they came
// from — template files, localStorage session snapshots, journal replays.
//
// Method: map each char back to the byte CP-1252 would have produced it from,
// then strictly decode those bytes as UTF-8. Only true mojibake survives that
// round-trip (a lone "â" in real prose fails strict decoding and the original
// string is returned untouched), so the repair is provably non-destructive.

// Unicode codepoint → the CP-1252 byte that renders as it (0x80–0x9F block).
const CP1252_REV: Record<number, number> = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
  0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
  0x017e: 0x9e, 0x0178: 0x9f,
};

export function demoji(s: string): string {
  // Fast path: mojibake always contains â (0xE2) or Ã (0xC3) lead bytes.
  if (!s.includes("â") && !s.includes("Ã")) return s;
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0xff) bytes.push(cp);
    else if (CP1252_REV[cp] != null) bytes.push(CP1252_REV[cp]);
    else return s; // genuine non-Latin unicode — this is not mojibake
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    return s; // didn't round-trip as UTF-8 — real text, leave it alone
  }
}

/** Heal every string in a JSON-shaped value (specs, snapshots, replays). */
export function demojiDeep<T>(v: T): T {
  if (typeof v === "string") return demoji(v) as unknown as T;
  if (Array.isArray(v)) return v.map(demojiDeep) as unknown as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = demojiDeep(val);
    return out as unknown as T;
  }
  return v;
}
