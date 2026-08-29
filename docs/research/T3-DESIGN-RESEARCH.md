# T3 Chat & T3 Code as design influence for the Artemis overhaul

Primary-source research, 2026-08-29. Every claim cites the source that owns it; anything
inferred or unverifiable is marked. Sources ranked per
[research-vendor-recommended-paths]: the vendor's own shipped artifacts first.

**How this was researched.** The live `t3.chat` app sits behind a Vercel security
checkpoint when fetched non-interactively, so T3 Chat claims come from its *shipped
assets* captured by the Wayback Machine — the real production CSS and JS bundles served
to users — plus Theo Browne's own posts. T3 Code is fully open source, so it was cloned
and read directly at commit
[`053affbe`](https://github.com/pingdotgg/t3code/commit/053affbed2659f90cd1b1efaaa7a75865c4131c7)
(2026-08-28). File links below pin to that commit.

Key primary sources:

- T3 Code repo: <https://github.com/pingdotgg/t3code> (MIT, cloned at `053affbe`)
- T3 Chat shipped CSS (Tailwind v4 build, captured 2026-03-16):
  <http://web.archive.org/web/20260316001746cs_/https://t3.chat/assets/styles-B90U-sVa.css>
- T3 Chat shipped app bundles (captured 2026-02-25 / 2026-03-11):
  <http://web.archive.org/web/20260225214455js_/https://t3.chat/assets/chat-BHvS3Fwj.js>,
  <http://web.archive.org/web/20260311053934js_/https://t3.chat/assets/_chat-ByO-4-Rm.js>
- T3 Chat shipped FAQ chunk (captured 2026-03-07):
  <http://web.archive.org/web/20260307023725js_/https://t3.chat/assets/_docs.faq-D3gbOUgG.js>
- Theo's X posts (fetched via Twitter's syndication API; individually cited below)

## Summary — and the T3 Code vs T3 Chat verdict

**T3 Chat** (t3.chat) is Ping Labs' consumer multi-model AI chat app. Theo announced it
on 2025-01-11: "I made the fastest AI chat bot ever"
([tweet](https://x.com/theo/status/1878028462822502788)). It is closed source, $8/mo Pro,
famous for speed, a pink not-quite-white/not-quite-black palette, and an opinionated
model picker.

**T3 Code** (t3.codes, repo `pingdotgg/t3code`) is a **different, 2026 product**: an
open-source **"agent harness control surface"** — their own words in the
[README](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/README.md) —
that drives Claude Code, Codex, Cursor, Grok Build, and OpenCode CLIs from web,
**Electron desktop**, and mobile clients. Publicly launched 2026-03-07: "T3 Code is now
available for everyone to use. Fully open source."
([tweet](https://x.com/theo/status/2030071716530245800), plus a
[launch-video post](https://x.com/theo/status/2030126522577879327)). Their
[AGENTS.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/AGENTS.md)
describes it as "an open source 'bring-your-own-subscription' alternative to apps like
Claude Desktop, Codex App, Cursor Glass and Conductor" with >200k users.

**Why this matters for Artemis:** T3 Code is the same product category as Artemis
(Electron + React harness over agent CLIs, including the Claude Agent SDK's CLI), built
by the team whose chat app defined the visual language we admire — and because it is MIT
licensed and open, its design decisions are readable at implementation depth, not just
screenshot depth. T3 Chat supplies the visual identity and the model-picker/limits UX;
T3 Code supplies the workspace, terminal-pane, settings, and theming architecture.

---

## 1. Visual design

### 1.1 T3 Chat palette — actual shipped values

Source: the production stylesheet
([styles-B90U-sVa.css, archived 2026-03-16](http://web.archive.org/web/20260316001746cs_/https://t3.chat/assets/styles-B90U-sVa.css)).
T3 Chat ships **two theme families × two appearances** as CSS classes on `<body>`:
`.theme-default` (the pink identity) and `.theme-boring` (grey; the in-app "boring
theme"), each with a `.dark` variant. All values below are verbatim from that file.

**`.theme-default` (pink) — light:**

| Token | Value |
| --- | --- |
| `--background` | `#f2e1f4` |
| `--chat-background` | `#fdf7fd` |
| `--sidebar-background` | `#ead0ef` |
| `--foreground` | `#501854` |
| `--primary` | `#e33f86` |
| `--secondary` / `--accent` | `#f1c4e6` |
| `--muted` | `#eaa7cb` |
| `--muted-foreground` | `#ac1668` |
| `--border` | `#eee1ed`; `--chat-border: #efbdeb` |
| `--color-heading` | `#560f2b` |
| `--wordmark-color` | `#ca0277` |
| `--chat-input-gradient` | `#fbccff` |

**`.theme-default` — dark.** The famous not-pure-black: the canvas is a **plum-tinted
near-black**, not grey and not `#000`:

| Token | Value |
| --- | --- |
| `--background` | `#21141e` |
| `--chat-background` | `#1f1a24` |
| `--sidebar-background` | `#131314` |
| `--foreground` | `#f9f8fb` |
| `--primary` | `#a3004c` (with `--primary-foreground: #fbd0e8`) |
| `--secondary` | `#362d3d`; `--accent: #463753` |
| `--muted` | `#423a45`; `--muted-foreground: #e7d0dd` |
| `--border` | `#27242c`; `--chat-border: #322028` |
| `--color-heading` | `#c46095` |
| `--wordmark-color` | `#e3bad1` |
| `--chat-input-gradient` | `#432d48` |

**`.theme-boring` light / dark** (grey family, same structure): light background
`#ebebeb`, chat `#fafafa`, primary `#ad5273` (the pink survives, desaturated); dark
background `#151515`, chat `#1f1f1f`, sidebar `#131313`, primary `#763750`, borders
`#282828`. Even "boring" dark is **`#151515`, not `#000`**, with surfaces stepping
`#131313 → #151515 → #1f1f1f`.

Other design tokens from the same file:

- **Radius:** `--radius: .5rem` with derived sm/md/lg steps.
- **Motion:** a custom easing `--ease-snappy: cubic-bezier(.2,.4,.1,.95)`; default
  transition duration `.15s`.
- **Glass:** `--chat-overlay` and `--chat-input-background` are HSLA with a
  `--blur-fallback` custom property, i.e. translucency degrades gracefully where
  backdrop blur is unavailable.
- **Signature gradients:** `--gradient-noise-top` (a noise-textured gradient cap over
  the chat), and `--gradientBorder-gradient` — a two-layer `linear-gradient` border trick
  for the chat input (`#93335b` alpha ramps in light; `--min`/`--max` pink variables in
  dark).
- **Typography:** `--font-sans: "ProximaVara"` (a variable Proxima Nova), `--font-mono:
  "BerkeleyMono"` — both licensed faces over system fallbacks. Accessibility alternates
  ship as first-class tokens: `--font-atkinson` (Atkinson Hyperlegible),
  `--font-dyslexic` (OpenDyslexic), `--font-intel-mono` (Intel One Mono). The early
  Next.js build (archived
  [2025-02-11](http://web.archive.org/web/20250211010938/https://t3.chat/settings/customization))
  used Geist/Geist Mono, so the identity fonts were a deliberate later investment.
- **Model-picker-specific tokens** exist at theme level: `--model-primary`,
  `--model-muted`, `--model-selector-gradient` (dark: a vertical
  `#1a141e → #120e14 → #070309` gradient behind the picker).

### 1.2 T3 Code palette — a second, quieter system

Source:
[apps/web/src/index.css](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/index.css)
(Tailwind v4 `@theme` + semantic role variables).

- **Light:** background is `--color-zinc-25` — a custom `oklch(99.2% 0 0)` step *between
  white and zinc-50* — with white cards, zinc-50 sidebar, zinc-200 borders.
- **Dark:** background `--color-neutral-950` with an explicit comment: *"Keep the
  workspace in the same neutral-black family… Surfaces lift from this base instead of
  starting from a milky gray."* Cards are `color-mix(in srgb, var(--background) 97%,
  var(--color-white))` — surfaces are **computed 3–6% white lifts of the canvas**, not
  hand-picked greys. Borders are alpha: `--alpha(var(--color-white) / 6%)`, inputs 8%.
  The sidebar in dark is **pure `#000`** with `#191a1d` accent rows (a deliberate
  step *darker* than the canvas, opposite of T3 Chat).
- **Accent:** `--primary: oklch(0.488 0.217 264)` light / `oklch(0.571 0.21 264)` dark —
  a blue-violet, brightened rather than desaturated for dark mode.
- **Radius:** `--radius: 0.625rem` with sm→4xl derived steps.
- **Density geometry is tokenized** so surfaces can't drift: `--control-radius: 0.5rem`,
  `--sidebar-content-inset: 0.5rem`, `--workspace-topbar-height: 52px`, plus glass
  tokens (`--glass-blur: 12px` light / `16px` dark, `--glass-opacity: 80%`,
  `--glass-saturation`). Comment: "Keep these values semantic so sidebar, palette,
  tooltip, and toolbar controls cannot quietly drift apart."
- **A contrast layer wraps every foreground token** (`--contrast-foreground`,
  `--appearance-contrast-boost`…): Settings → Appearance has a Contrast slider that
  mixes all text/border roles toward black/white without a second palette
  ([settingsSearch.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/settings/settingsSearch.ts)).
- **Fonts:** system stacks by default, but Appearance exposes four independent font
  slots — Interface, Prompt, Code, Terminal — plus font smoothing (same
  settingsSearch.ts catalog; also Theo's
  [2026-08-07 update post](https://x.com/theo/status/2085639979011891445): "Added
  configurable fonts and sizes").

### 1.3 T3 Code theming machinery (the vendor's recommended path)

This is where they're clearly investing going forward:

- **Semantic roles → Tailwind v4 `@theme inline` mapping.** Components consume
  `--color-sidebar-row-hover`-style roles; themes only redefine the role variables
  ([index.css](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/index.css)).
- **Seeded theme generation:** a theme can be just `{name, appearance, canvas, accent}`
  and T3 Code derives the full palette "the same way the guided theme editor does"
  ([docs/user/environment-theme.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/environment-theme.md)).
  Full role-by-role overrides are optional layers on top.
- **Built-in themes** include Grove, Ocean, Ember, Iris — and one literally named
  **"T3 Chat"**, a pink light theme (`canvas: oklch(0.982446 0.010114 325.653)`) porting
  the chat identity into the code tool
  ([themePalettes.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/packages/shared/src/themePalettes.ts)).
- **Theme editor as a floating overlay** (`mod+alt+shift+t`): select a color label to
  *spotlight every element using it*; an **Inspect** mode click-picks an element and
  reveals its token; advanced mode groups tokens into color families
  ([docs/user/keybindings.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/keybindings.md)).
- **VS Code theme import** exists
  ([vscodeThemeImport.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/vscodeThemeImport.ts)).
- **Environment-published themes:** the *server machine* can publish theme JSON files to
  `~/.t3/userdata/themes/`, and connected clients retint live; `t3 theme set nightfall`
  pushes a theme to every client (environment-theme.md, above). Themes are per-client
  choices; a phone doesn't follow the desktop.
- **Density/spacing in practice:** chat transcript max width 768px
  (`TIMELINE_CONTENT_MAX_WIDTH`,
  [MessagesTimeline.logic.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/chat/MessagesTimeline.logic.ts));
  compact 6px scrollbars; `52px` topbar with Electron Window-Controls-Overlay support via
  a `wco` Tailwind variant reading `env(titlebar-area-*)` (index.css).

---

## 2. Model picker UX

### 2.1 T3 Chat (from the shipped bundle)

All from the archived
[chat bundle](http://web.archive.org/web/20260225214455js_/https://t3.chat/assets/chat-BHvS3Fwj.js) /
[_chat bundle](http://web.archive.org/web/20260311053934js_/https://t3.chat/assets/_chat-ByO-4-Rm.js)
unless noted:

- **Model metadata is a first-class catalog**: `getModelMetadata`, `getModelName`,
  `modelHasFeature(model, "images")`, `nativePDFs` (files show a PDF icon when the model
  reads PDFs natively, an OCR icon otherwise — `getFileIcon`), `apiKeySupport` per model,
  `isRetiredModel` / `getModelSuccessor` (retired models point at their replacement),
  `isActiveModel`, and `isRecentlyAdded(model.addedOn)` driving a **NEW** indicator.
- **Cost is communicated as a tier glyph, not numbers**: `ModelCostIndicator` +
  `getModelCostTier`; the logged-out archived homepage renders the current model as
  "Kimi K2 (0905) `$` `$`" — dollar-sign pips next to the model name
  ([archived homepage 2026-06-13](http://web.archive.org/web/20260613054857/https://t3.chat/)).
- **Favorites + pinning:** model tooltips carry a `showPinButton`; the composer's corner
  menu has a **Favorites** submenu with a star icon; threads separately support
  pin/unpin. Favorite management lives in settings (`/settings/models` strings present;
  exact page layout unverified — login-walled).
- **Reasoning effort is part of the picker**, not a buried setting:
  `ReasoningEffortSelector` with per-model `getReasoningEffortOptions`, icon-coded
  (Brain / BigBrain for medium/high), tooltip "Reasoning Effort".
- **Gating is done via disabled-with-reason, not hiding:** `getModelDisabledState`
  returns a `reason` rendered in the row's tooltip (`disabledReason` prop on
  `ModelTooltip`); free tier locks efforts above `low` with a toast "Upgrade to a paid
  plan to access higher reasoning efforts"; BYOK-only efforts toast "API key required";
  attachments for free users show "Attaching files is a subscriber-only feature" and an
  "Upgrade to Pro" toast **with an inline upgrade action** wired straight to the billing
  product (`AUTUMN_PRODUCTS.PRO`).
- **Model creator shown as sub-label:** a display map `{"Z.ai": "GLM", Kimi, MiniMax,
  Stealth…}` labels third-party-hosted models by their creator.
- **Keyboard:** `Cmd/Ctrl+/` opens the model selector from the composer (keydown handler
  on `Slash`).
- *Unverified (login-walled):* the picker's visual grid-of-cards layout and the
  "Show all / filter by capability" affordances often shown in Theo's streams could not
  be observed directly; only the underlying code paths above are verified.

### 2.2 T3 Code (from source)

The picker is a **combobox with a provider rail** — worth studying as a whole
([ModelPickerContent.tsx](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/chat/ModelPickerContent.tsx),
[ModelPickerSidebar.tsx](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/chat/ModelPickerSidebar.tsx),
[ModelListRow.tsx](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/chat/ModelListRow.tsx)):

- **Left rail = provider *instances*, not providers.** One icon per configured instance
  ("Codex" and "Codex Personal" are two rail items), plus a **Favorites** star item at
  the top. Unavailable instances stay visible with tooltip explanations ("— Disabled in
  settings.", "— Unavailable.", "— Limited.").
- **Rows:** provider icon, model display name, optional `subProvider` footer
  ("OpenCode · Anthropic"), star toggle per row, gold "NEW" chip (curated set in
  [modelPickerModelHighlights.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/chat/modelPickerModelHighlights.ts)),
  per-instance accent colors, disabled reasons, and a `Kbd` jump label.
- **`mod+1`…`mod+9` jump straight to the Nth model while the picker is open** (a
  `modelPickerOpen` `when`-context in
  [keybindings.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/packages/shared/src/keybindings.ts));
  `mod+shift+m` toggles the picker globally.
- **Search** is multi-field token scoring (name, shortName, subProvider, driver kind,
  instance display name; exact > prefix > word-boundary > includes > fuzzy) with a flat
  **favorite score boost** of 24
  ([modelPickerSearch.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/chat/modelPickerSearch.ts)).
- **Ordering:** user-defined `modelOrder` per instance, optional "group favorites
  first", stable fallback to catalog order — all pure `Order` combinators
  ([modelOrdering.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/modelOrdering.ts)).
  Settings → Providers lets users hide/reorder models per instance
  (`ProviderModelsSection.tsx`).
- **Editing an old message locks the picker to the driver kind that served the turn**
  but still allows switching between instances of that kind (doc comment in
  ModelPickerContent.tsx).
- **Virtualized** with LegendList — the picker, the transcript, and comboboxes all use
  `@legendapp/list`.
- New threads **inherit model + mode from the thread you were viewing**; defaults come
  from per-project configured defaults
  ([docs/user/keybindings.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/keybindings.md),
  release note "honor project default models in new threads",
  [v0.0.36](https://github.com/pingdotgg/t3code/releases/tag/v0.0.36)).

---

## 3. Menus, settings, information architecture

### 3.1 T3 Code settings IA

Sidebar sections, in shipped order (single source of truth in
[settingsSearch.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/settings/settingsSearch.ts)):
**General · Appearance · Keybindings · Providers · Integrations · Source Control ·
Connections · Archive**.

Notable mechanics:

- **Settings search with anchor targets.** Every searchable setting is one entry in a
  catalog (`id`, `title`, `to`, `targetId`) and panels render titles *from the catalog*,
  so search, sidebar, and page headings can never disagree. Results deep-link and scroll
  to the anchor. Desktop-only rows are flagged so web search doesn't land on a missing
  anchor.
- **Keybindings page lists every command, its shortcut, default-vs-custom status, and
  conflicts**; the same data lives in `~/.t3/userdata/keybindings.json` (JSON array of
  `{key, command, when}` rules; last-match-wins; `when` expressions over UI context keys
  like `terminalFocus`, `modelPickerOpen`)
  ([docs/user/keybindings.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/keybindings.md)).
- **Command palette (`mod+k`)** searches thread titles, projects, branches, user
  messages, and final agent responses **across all connected environments**, showing a
  labeled excerpt per message match (same doc). `mod+p` file picker, `mod+shift+f`
  project-wide text search.
- **Default keymap** (from
  [keybindings.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/packages/shared/src/keybindings.ts)):
  `mod+b` sidebar · `mod+j` terminal · `mod+alt+b` right panel · `mod+d` diff (or split
  terminal when terminal focused) · `mod+shift+j` preview · `mod+k` palette · `mod+n` /
  `mod+shift+o` new chat · `mod+shift+m` model picker · `mod+s` stash prompt ·
  `mod+shift+s` settle thread · `mod+shift+p` pin thread · `mod+shift+[`/`]` prev/next
  thread · `mod+1..9` thread jump.
- **Providers settings = instance cards** with display name, binary path, config-dir
  path, env vars (sensitive values stored server-side as secrets and never echoed back),
  launch args, per-instance accent color, an "Early Access" badge at the driver level,
  and a wizard for adding instances
  ([providers-claude.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/providers-claude.md),
  `ProviderInstanceCard.tsx`, `providerDriverMeta.ts`).
- **Composer menus:** `/` opens commands (optionally including skills), `$` inserts
  skills, with source labels System/Personal/Project/App
  ([docs/user/composer.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/composer.md)).
- **Permission modes** are a composer-level, per-thread control with four fixed labels —
  Supervised / Auto-accept edits / Auto / Full access — mapped per provider, with the
  honest caveat that per-provider translation "is internal and may change"
  ([docs/user/permission-modes.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/permission-modes.md)).

### 3.2 T3 Chat settings IA

Verified from archived route captures (the app is an SPA; only routes and bundle strings
are observable logged-out): `/settings/customization`, `/settings/api-keys`,
`/settings/attachments`, `/settings/contact` existed as URLs
([Wayback CDX for t3.chat/settings/*](http://web.archive.org/cdx/search/cdx?url=t3.chat/settings/*)),
and the bundle contains "Models" and "Subscription" section strings. The full tab list
and layout are **unverified** (login-walled).

Keyboard-first affordances verified in the bundle
([_chat bundle](http://web.archive.org/web/20260311053934js_/https://t3.chat/assets/_chat-ByO-4-Rm.js)):

- `Cmd/Ctrl+Shift+O` → new chat; `Cmd/Ctrl+Shift+Backspace` → delete current thread;
  `Cmd+Alt+↑/↓` → previous/next thread; `Cmd/Ctrl+/` → model picker; `Alt+T` →
  notifications (string "Notifications alt+T" in the settings payload).
- **Type-anywhere-to-focus:** any plain alphanumeric keypress outside an input focuses
  the composer (explicit keydown handler).
- **Send behavior is configurable**: `requireModifierToSend` + `sendModifier`
  (shift/alt/ctrl/meta/any) — Enter vs modifier-Enter as a user setting.
- Thread list: search box ("Search your threads…"), pin/unpin, multi-select with
  archive/delete/export **JSON and Markdown**, and **move-to-profile**.
- **Profiles**: named workspaces within one account — create dialog offers "Profile
  name" + "Copy settings from…" / "Start from scratch". (Marketing framing of profiles
  is login-walled; the mechanics are in the bundle.)

---

## 4. Accounts, usage limits, credits

### 4.1 T3 Chat — the two generations of limits

**Gen 1 (2025): message buckets.** From Theo's
[2025-02-05 post](https://x.com/theo/status/1887000229922353524): Pro = 1,500
messages/month; "Claude is limited to 100 messages/month so we don't go broke"; $8 buys
100 more Claude messages; existing subs were grandfathered 250.

**Gen 2 (2026): the usage bar.** From Theo's
[2026-02-15 post](https://x.com/theo/status/2022844310165893484): "We just overhauled
how credits work on T3 Chat. No more 'standard' and 'premium' credits. Now you have a
'usage' bar that resets every 4 hours."

The exact mechanics ship in T3 Chat's own FAQ
([archived FAQ chunk](http://web.archive.org/web/20260307023725js_/https://t3.chat/assets/_docs.faq-D3gbOUgG.js)):

> "The meter uses two buckets: a Base bucket and an Overage bucket. Usage always spends
> from Base first, then Overage. Base refills every 4 hours, and Overage refills on your
> monthly renewal date. If both are depleted, you need to wait for capacity to refill.
> In settings, these are shown as separate percentage bars…"

> "Whenever you send a message, we reserve an expected cost from your available
> balances… Once the response completes, we settle the final cost by either crediting
> back unused reserved amount or deducting any additional usage." (The FAQ openly
> explains why the meter "jumps around".)

The FAQ also names the cost drivers users see: long threads (context resent per turn),
premium models, attachments. Their billing partner Autumn's write-up
([useautumn.com](https://useautumn.com/blog/working-with-t3-chat-on-a-new-way-of-pricing),
vendor-of-the-billing-system source) adds the design rationale — **"fear of running
out"**: "almost no users ever hit their limit of 1500 messages… they were paranoid that
they would", so the redesign optimizes for *never being more than a few hours from
usable again*; it also documents the $50 "Premier" tier (~10× usage) and conversion of
legacy top-ups into a standalone credit balance.

Other verified account mechanics: BYOK API keys page (`/settings/api-keys`);
per-provider quota errors rendered with actionable guidance (e.g. Anthropic key
insufficient → link to dashboard; Gemini free-quota explanation — bundle strings);
`isLapsedSubscription` handling in the client; model access differences enforced through
the disabled-reasons system in §2.1 rather than hiding models.

### 4.2 T3 Code — bring-your-own-subscription and multi-account

- **No resale, no metering of their own:** "T3 Code doesn't resell tokens. Plug in
  Claude Code, Codex, OpenCode, Cursor, or Grok with the credentials you already have —
  we orchestrate them, you keep your plan."
  ([marketing site source, in-repo](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/marketing/src/pages/index.astro)).
- **Multiple Claude accounts = multiple provider instances keyed by
  `CLAUDE_CONFIG_DIR`** — exactly Artemis's approach. Their doc is explicit: set
  `CLAUDE_CONFIG_DIR`, *not* `HOME`; the settings page shows each instance's logged-in
  email, **blurred by default, click to reveal**; an existing thread only offers Claude
  instances sharing the same config dir ("A different config directory is treated as a
  different Claude environment"), unlike Codex where account switching mid-thread is
  supported
  ([docs/user/providers-claude.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/providers-claude.md),
  [providers-codex.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/providers-codex.md)).
  Router/OpenRouter setups are just more instances with env vars.
- **Usage page** aggregates Codex + Claude Code + Grok **by reading the providers' local
  session history**: API-equivalent token cost, processed tokens, cache savings,
  provider shares, model breakdowns; rolling-24h hourly chart plus 7/30/90-day daily
  ranges; explicit disclaimer that subscription billing is separate
  ([docs/user/usage.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/usage.md)).
- **Context pressure UX:** a per-thread context meter with a **Compact context** action,
  an offer to compact when reopening an old large-context thread, and a per-instance
  "Auto-compact after N tokens" setting
  ([providers-claude.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/providers-claude.md),
  `ContextWindowMeter.tsx`).

---

## 5. T3 Code terminal & workspace panes (for the Artemis dock overhaul)

This is T3 Code's core layout thesis, stated on their own marketing page: **"Your agents
deserve better than a terminal."**
([index.astro](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/marketing/src/pages/index.astro)).
The workspace is: left thread sidebar · center conversation · **right panel of tabbed
surfaces** · **bottom terminal drawer**.

### 5.1 The right panel: thread-scoped tabbed "surfaces"

Source:
[rightPanelStore.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/rightPanelStore.ts)
(the doc comments are excellent) and
[RightPanelTabs.tsx](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/RightPanelTabs.tsx).

- **Seven surface kinds:** `diff`, `files` (tree), `file` (single file at a path, with
  reveal-line support), `preview` (embedded browser tabs), `terminal`, `pull-request`,
  `agents`. Each renders as a tab with a lucide icon (FileDiff, Files, Globe2,
  TerminalSquare, GitPullRequest, Bot) — preview tabs show the site favicon.
- **Ownership is per-thread.** The store is keyed by scoped thread ref; each thread
  remembers its own open surfaces, order, and active tab, **persisted** (zustand
  `persist`, storage version 11). Switching threads switches the whole panel state.
- **Singleton vs keyed tabs:** diff/files/agents are singletons per thread; files,
  preview tabs, terminals, and **multiple PRs open as peer tabs** keyed by resource
  (`pull-request:<repo>#<n>`, `browser:<tabId>`, `terminal:<sessionId>`).
- **Browser-grade tab management:** close, **close others**, **close to the right**,
  close all — all in the tab context menu, with keyboard shortcuts rendered via a `Kbd`
  component in menus.
- **Layout behavior:** panel width is user-resizable and persisted per surface
  (`widthStorageKey`); below a 980px container width the panel becomes an overlay
  **sheet** (`w-[min(42vw,28rem)]`,
  [rightPanelLayout.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/rightPanelLayout.ts));
  a `rightPanel.toggleMaximized` command maximizes the panel; `mod+alt+b` toggles it.
- **Instructive reversal:** storage v9 note — *"removed the 'plan' surface kind (plans
  render inline in the transcript)"*. They tried plans-as-a-pane and moved them back
  into the conversation.
- **PR review in the panel:** open several PRs from the Pull Requests page as tabs, or
  open a thread's linked PR "in the same compact right-panel tabs without leaving the
  conversation"; cmd-click a PR number opens the browser instead
  ([docs/user/source-control.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/user/source-control.md)).
- **Agents surface:** subagent/workflow observability — "see what your agents spawn"
  ([Theo, 2026-08-07](https://x.com/theo/status/2085639979011891445);
  `AgentsPanel.tsx`).

### 5.2 Terminals

- **Renderer:** Ghostty's terminal core compiled in (`libghostty-vt`) — announced in the
  same 2026-08-07 post; implementation under
  [apps/web/src/terminal/ghostty/](https://github.com/pingdotgg/t3code/tree/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/terminal)
  with themeable `GhosttyTheme` colors wired to app theme roles
  (`--terminal-background: var(--background)` — the terminal sits on the app canvas, not
  its own black).
- **Two placements:** a per-thread **bottom drawer** (default height 280px,
  [types.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/types.ts))
  *and* terminal tabs in the right panel; both host **split groups** (horizontal or
  vertical, max 4 terminals per group).
- **Keyboard (terminal-focused `when`-context):** `mod+j` toggle drawer · `mod+d` split
  · `mod+shift+d` split vertical · `mod+n` new terminal · `mod+w` close (with a
  close-confirm guard) — the same keys mean different things outside terminal focus,
  resolved by `when` clauses.
- **Terminal → conversation bridge:** selected terminal output can be attached to the
  composer as context chips (`ComposerPendingTerminalContexts.tsx`,
  `terminalContext.ts`), and URLs printed in the terminal open in the preview surface
  (`openTerminalLinkInPreview.ts`); file paths resolve to editor/file-surface targets
  (`terminal-links.ts`).
- Terminals run **server-side** (the execution boundary) and clients attach over the
  same WebSocket (`terminal.attach` stream,
  [docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/internals/overview.md)).

### 5.3 Long output in the transcript (what stays inline vs. what overflows)

- **Work-log collapsing:** tool/command activity within a turn renders as a group with
  `MAX_VISIBLE_WORK_LOG_ENTRIES = 1` — only the latest entry shows while collapsed;
  expanding shows in-progress and progress entries; neutral-status entries are hidden
  entirely
  ([MessagesTimeline.logic.ts](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/components/chat/MessagesTimeline.logic.ts)).
  Ordinary tool failures deliberately do *not* get red-X summaries
  ([v0.0.36 release notes](https://github.com/pingdotgg/t3code/releases/tag/v0.0.36)).
- **Changed files per turn** render as a compact tree that keeps "older collapsed
  changes to a one-line receipt" (ChangedFilesTree tests), with a diff-stat label; the
  *full* diff lives in the diff surface, backed by **per-turn git checkpoints** so turn
  diffs and reverts are exact
  ([overview.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/internals/overview.md)
  — checkpointing section).
- **Timeline minimap:** a dot-per-message vertical minimap in the transcript gutter
  (`TIMELINE_MINIMAP_*` constants) for jumping through long threads.
- **Live-follow with a re-arm band:** autoscroll re-arms only within 40px of the true
  bottom, with a comment explaining that LegendList's half-viewport `isNearEnd` "yanked
  [users] back down" while reading history — a hard-won streaming-transcript detail
  (same file).
- **Approvals and questions are composer panels**, not transcript noise: pending
  approvals, plan follow-ups, and agent questions stack as banners above the input
  (`ComposerPendingApprovalPanel`, `ComposerBannerStack` — the collapsed stack shows a
  colored "cap" peeking above the front banner to hint more are hidden).

### 5.4 Visual treatment of panes

- Tabs are compact icon+label rows in a 52px chrome row; density comes from the shared
  geometry tokens (§1.2) so the panel, sidebar, and palette agree; scroll areas get
  fade-out edges (`getVirtualizedScrollFadeClassName`).
- Preview surface has its own toolbar (URL focus `mod+l`, refresh `mod+r`, zoom
  `mod+=`/`mod+-`/`mod+0`), a **mini-player** mode (`previewMiniPlayerStore.ts`) and an
  element-annotation flow that feeds screenshots/notes back into the composer
  (`ComposerPreviewAnnotationCards.tsx`); hidden previews are actively throttled to stop
  battery drain ([v0.0.36](https://github.com/pingdotgg/t3code/releases/tag/v0.0.36)).

---

## 6. Implementation details that translate to Electron + React

### 6.1 T3 Chat's data-layer arc — local-first, then a sync engine

- **Dexie era (Jan 2025):** Theo built the launch version on Dexie/IndexedDB — "oh MAN
  is this good… Combine it with react compiler and you can stream updates to a specific
  message without the others updating"
  ([2025-01-06 tweet](https://x.com/theo/status/1876201382770040913)).
- **Convex rewrite (May–June 2025):** the move to Convex as data layer + sync engine was
  "effectively a full rewrite", took multiple failed attempts (Theo's public
  "ACCOUNTABILITY POST" threads:
  [2025-05-28](https://x.com/theo/status/1927633117977956858),
  [2025-06-01](https://x.com/theo/status/1929264138544615464)), and they **dropped the
  local-only/cloud-sync switch** in the process. Convex's own postmortem of the June 1
  outage documents T3 Chat's operational profile (heavy text search, many long-lived
  background tabs)
  ([news.convex.dev](https://news.convex.dev/how-convex-took-down-t3-chat-june-1-2025-postmortem/)).
- **Current shipped stack (verified in the 2026 bundles):** Convex client
  (`useConvex`, `api.threads.*`, `usePaginatedQuery`, optimistic updates,
  a `convex-optimistic-pagination` chunk), **React Compiler** output
  (`require_compiler_runtime` memo-cache slabs throughout), TanStack Router hooks
  (`useNavigate`/`useBlocker`), Vite asset pipeline (the 2025 captures were Next.js;
  the 2026 captures are Vite `assets/` — *migration inferred from shipped assets*, the
  framework switch itself is corroborated only by secondary write-ups), Jotai-style
  atoms, and Tailwind v4.
- **Lesson for Artemis** (their revealed preference, not our inference to adopt
  blindly): pure client-local storage made multi-device sync and reliability the
  bottleneck; they paid a rewrite to get a server-authoritative sync engine while
  keeping optimistic local reads. Artemis is local-machine-native (the SDK runs
  locally), so our equivalent is T3 *Code's* answer, below.

### 6.2 T3 Code's architecture — the closer analog

From
[docs/internals/overview.md](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/docs/internals/overview.md)
and AGENTS.md:

- **Server owns everything; clients are dumb views.** One Node server owns provider
  processes, terminals, git, filesystem; web/desktop/mobile talk to it over a single
  authenticated **Effect RPC WebSocket** with per-method scopes and subscription
  streams. The Electron app is a shell that supervises a local server and loads the same
  web bundle over a custom `t3code://` protocol.
- **Event-sourced orchestration:** clients dispatch typed commands; a single-fiber
  engine appends events + projects read models in one SQLite transaction; retries are
  idempotent via command receipts. This is what makes multi-client/remote "free".
- **State on SQLite** (`~/.t3/userdata/state.sqlite`), themes/keybindings as JSON files
  beside it — filesystem-inspectable, atomically written.
- **Performance is a stated product pillar** (AGENTS.md: "Performance without
  compromise… we regularly audit for performance regressions, often caused by sending
  too much data over websockets, css animations causing gpu spikes, lists being hard to
  render"). Concrete techniques in shipped code:
  - **Duty-cycled CSS animations:** status pulses and loading "ghosts" animate with
    `steps()` and long holds; the in-CSS comment quantifies it — "on a 120Hz display
    …the difference between ~14 and ~288 updates" per cycle
    ([index.css](https://github.com/pingdotgg/t3code/blob/053affbed2659f90cd1b1efaaa7a75865c4131c7/apps/web/src/index.css)).
  - **LegendList virtualization** for transcript, pickers, and long lists.
  - Transform-only skeleton sweeps that stay on the compositor.
  - View Transitions API for the mobile composer morph.
- **Theming approach** (§1.3) is plain CSS custom properties + Tailwind v4 `@theme
  inline` mapping + runtime overrides — no CSS-in-JS, trivially portable to Artemis.

---

## 7. Translation to Artemis

Patterns worth adopting, ranked; each with the source that owns it.

1. **Thread-scoped tabbed surface model for the dock** (§5.1). Adopt T3 Code's exact
   shape: a per-conversation ordered list of typed surfaces (terminal / diff / file /
   browser / agents), singleton-vs-keyed ids, persisted per thread, close/others/right
   context menus, sheet-mode below a width threshold, and a maximize command. Their v9
   reversal (plans back inline) is a scoping lesson: *outputs you read alongside the
   chat* belong in panes; *decisions* belong in the transcript.
2. **Semantic role tokens + seeded themes** (§1.2–1.3). Move Artemis to a role-variable
   palette where dark surfaces are computed lifts of one canvas
   (`color-mix(... 97%, white)`) and borders are white-alpha. Offer themes as
   `{canvas, accent}` seeds with derived everything-else, and consider the
   spotlight/inspect theme editor later. This is also how we could ship a "T3 Chat
   pink" theme legitimately — T3 Code itself does.
3. **Collapse-to-receipt transcript discipline** (§5.3). One visible work-log entry per
   activity group, one-line receipts for older changed-file trees, no red-X on routine
   tool failures, full detail one click away in the diff/terminal surface, timeline
   minimap for long threads, and the 40px follow re-arm band for streaming autoscroll.
4. **Usage bar with Base/Overage semantics + reserve-then-settle honesty** (§4.1). For
   Artemis's plan-usage display and account rotation, T3 Chat's model is the strongest
   pattern in the wild: short-window bucket first, monthly bucket second, separate
   percentage bars, and an FAQ-level explanation of why the meter moves. Pairs directly
   with [ACCOUNT-ROTATION-ALGORITHM.md](./ACCOUNT-ROTATION-ALGORITHM.md) — rotation is
   our "Overage".
5. **Provider-instance model picker** (§2.2). Rail of *instances* (not providers) with a
   Favorites pseudo-instance, per-row star, `mod+1..9` jump, multi-field scored search
   with favorite boost, disabled-with-reason rows, and lock-to-driver when editing an
   old turn. T3 Chat adds the consumer polish worth copying: cost-tier `$` pips,
   NEW-by-`addedOn`, retired→successor mapping, capability-driven attachment icons.
6. **Keybindings as data + `when` contexts + settings search catalog** (§3.1). A JSON
   rule file with context expressions, a settings page generated from the same data, and
   a searchable settings catalog with anchor deep-links.
7. **Multi-account via config-dir instances with blurred emails** (§4.2). Their
   `CLAUDE_CONFIG_DIR` instance model and "same-config-dir-only within an existing
   thread" rule agree with Artemis's existing approach and add two UI details worth
   stealing: click-to-reveal blurred account emails, and refusing cross-account
   continuation instead of silently switching.
8. **Terminal↔chat bridging** (§5.2): selection→context-chip, terminal-URL→preview pane,
   path→file surface. Cheap to build once the surface model exists; disproportionate
   payoff.
9. **Duty-cycled animation + virtualized-everything performance floor** (§6.2), with
   T3 Code's explicit audit list (WebSocket payload size, GPU-spiking CSS animations,
   unvirtualized lists) as a recurring checklist for Artemis reviews.
10. **Context meter with compact affordances** (§4.2): meter in the composer, one-click
    compact, offer-to-compact on reopening heavy threads, per-instance auto-compact
    threshold.

### Explicitly *not* recommended to copy

- **Convex-style hosted sync** (§6.1): T3 Chat needed it because it is a cloud consumer
  product; T3 Code — the product shaped like Artemis — chose a local server +
  event-sourced SQLite instead. That is the vendor's own revealed recommendation for
  this category.
- **Their reliance on provider CLIs' local session history for the usage page** (§4.2)
  is a fit for their BYO-CLI model; Artemis gets richer data from the Agent SDK
  directly.

## Unverified / inferred claims register

- T3 Chat model-picker *visual layout* (card grid, capability filter menu, "Show all"):
  login-walled; only the underlying code paths are verified (§2.1).
- T3 Chat full settings tab list beyond the four archived routes (§3.2).
- T3 Chat Next.js → TanStack migration: inferred from shipped-asset change plus
  secondary posts; no first-party statement located (§6.1).
- T3 Chat free-tier message counts: no first-party source found; deliberately omitted.
- Everything else in this document traces to a linked first-party artifact.
