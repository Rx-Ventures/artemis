# Themes derive from seeds, not hand-tuned token lists

Decided 2026-08-29, during overhaul prep. The palette in `index.css` was five
hand-picked surface lightnesses plus an accent, each edited by hand; the 2.0
overhaul replaces that with derivation — a theme is a `{canvas, accent}` seed
pair from which the surface ramp, hairlines, and accent variants are computed
(the T3 Code pattern: surfaces as small computed lifts off the canvas). We chose
this over both keeping hand-tuned tokens (every future theme costs a full
tuning pass) and over a user-portable theme-JSON format (a product feature
nothing currently needs; it can be layered onto seeds later, and the ChatGPT
app's portable-theme design is the reference if it ever is).

`palette.test.ts` remains the gate either way: contrast, gamut, and the 40°
hue-separation rule are asserted against the *derived* values, so a bad seed
fails CI exactly as a bad hand-edit did.
