# Surfaces belong to conversations, not the window

Decided 2026-08-29, during overhaul prep. The dock was one window-level rail
showing every visible pane's tabs at once, unlabelled — `docs/design/e-catch.html`
left "whose dock is it?" explicitly unresolved, and the forensic answer was
"everyone's and no one's": rival terminals indistinguishable in a split, preview
a window singleton panes stole from each other, restart keeping only the focused
pane's arrangement. The 2.0 dock adopts T3 Code's answer wholesale: a surface
(terminal, browser, file, preview, tasks, agent transcript) is owned by a
conversation, the visible set follows the focused conversation, and arrangements
persist **per session id** — which deliberately overturns the old restart rule
("an arrangement, not a session") because session ids, unlike pane ids, survive
a relaunch.

Consequences worth naming: the twenty load-bearing dock invariants catalogued in
OVERHAUL-PREP §7 still hold (only ✕ kills a shell, xterm parks and never
unmounts, main owns PTY lifetime); the rebuild also takes T3's sheet mode,
terminal splits, and the terminal↔chat bridges. Rendering stays xterm — Ghostty
is not embeddable in Electron.
