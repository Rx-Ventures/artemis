import math
# OKLCH -> sRGB, and WCAG contrast. Enough to answer "is this in gamut" and
# "does this clear AA", which is the bar index.css sets for itself.
def oklch_to_srgb(L, C, H):
    h = math.radians(H); a = C*math.cos(h); b = C*math.sin(h)
    l_ = L + 0.3963377774*a + 0.2158037573*b
    m_ = L - 0.1055613458*a - 0.0638541728*b
    s_ = L - 0.0894841775*a - 1.2914855480*b
    l, m, s = l_**3, m_**3, s_**3
    r = +4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bb= -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    return r, g, bb
def enc(u):
    return 12.92*u if u <= 0.0031308 else 1.055*u**(1/2.4) - 0.055
def in_gamut(L, C, H, eps=1e-4):
    return all(-eps <= v <= 1+eps for v in oklch_to_srgb(L/100, C, H))
def rel_lum(L, C, H):
    r, g, b = (max(0.0, min(1.0, v)) for v in oklch_to_srgb(L/100, C, H))
    return 0.2126*r + 0.7152*g + 0.0722*b
def contrast(fg, bg):
    a, b = rel_lum(*fg), rel_lum(*bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)
