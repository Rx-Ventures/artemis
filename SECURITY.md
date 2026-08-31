# Security

Artemis makes specific, checkable claims about where secrets can and cannot go.
Claims like that are worth testing, and a report that breaks one is welcome.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

**[Report a vulnerability →](https://github.com/seth-torrence/artemis/security/advisories/new)**

If that is unavailable to you, email **seth@storrence.dev**.

Please include the version, your platform, and the shortest sequence of steps
that shows the problem. A proof of concept is welcome and never required.

Artemis is a small project and this is not a funded programme: expect an
acknowledgement within a few days, and a fix or a written explanation of why
something is intended before any public disclosure. There is no bounty.

## The claims worth attacking

These are the load-bearing assertions in the [README](README.md#where-secrets-live).
A report that falsifies one of them is a real finding:

- **No secret crosses the IPC boundary into the renderer.** The preload exposes a
  fixed set of channels, none of which accepts or returns a token; `ipcRenderer`
  is never exposed or wrapped, and no channel name is built from renderer input.
  A way to reach a channel that is not in that fixed set is a finding.
- **Every `invoke` response is scanned on the way out** (`main/redact.ts`), and
  credential-shaped values throw in the main process rather than shipping to the
  renderer. A credential shape that slips the scanner is a finding.
- **A run inherits no credential variable.** `resolveEnv` writes exactly one
  variable — the provider's config-directory variable — and deletes every
  variable that could authenticate the provider some other way. A path where
  `ANTHROPIC_API_KEY` or another credential survives into a run's environment is
  a finding, and a serious one: it is the billing trap the design exists to make
  structural.
- **Profiles isolate accounts.** Two profiles pointed at different config
  directories must not be able to read each other's history or credential.

## Known, intended, and not vulnerabilities

Reporting these will get a polite pointer back here:

- **`profiles.json` is plaintext.** It holds labels, provider ids and directory
  paths. It is readable by design because there is nothing in it worth stealing.
- **Artemis does not encrypt credentials.** It holds none to encrypt. The
  provider CLI's own login writes its token into the profile's config directory,
  where that CLI keeps it, and Artemis reads a boolean back. This stays true on
  the one path where a *server* runs that login on a client's behalf: the URL
  the CLI prints and the code the user types are the whole of what crosses the
  wire, and neither end reads the file the CLI writes.
- **A connection token can be granted the power to add accounts to a server.**
  Off by default, per connection, and named on the command that mints it
  (`connection create --manage-profiles`). A token with it can register an
  account on the serving machine and drive the provider's login for it; a token
  without it gets a 404 from those routes, indistinguishable from a build that
  does not have them. Granting it to a token you then paste into an editor
  extension is a configuration mistake, not a vulnerability — but a way to
  reach those routes *without* the grant is a finding.
- **Model output is exempt from the redaction value patterns.** If a user pastes
  their own key into a prompt, the transcript legitimately contains it. Refusing
  to render the conversation would help nobody.
- **The window-state, updater and menu pushes are not scanned.** They carry
  booleans and version strings. Getting something else onto one of them *is* a
  finding — the absence of scanning is not.
- **A signed-in config directory grants access to that account.** That is what
  being signed in means. Anyone with read access to the directory has what the
  provider CLI has.

## Supported versions

Artemis is pre-1.0 and ships from `main`. Only the most recent release is
supported; fixes land in the next release rather than in backports.
