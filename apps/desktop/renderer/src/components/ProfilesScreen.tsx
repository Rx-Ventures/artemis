/**
 * Profile management.
 * ============================================================================
 *
 * A profile is a name and a config directory. That is the whole model, and it
 * is a deliberate collapse of what used to be here.
 *
 * ## What this screen used to ask for, and why it no longer does
 *
 * It asked for a provider, a hosting backend, an authentication mode, and a
 * pasted credential. Four decisions, of which the user could realistically make
 * one — and the instructions for the credential were, by then, impossible to
 * follow: they told the user to paste a token that the adapter had already
 * stopped emitting. The screen described a mechanism the app no longer had.
 *
 * What it actually has is simpler and better. `claude auth login`, run with
 * `CLAUDE_CONFIG_DIR` pointed at a directory, writes a credential belonging to
 * that directory alone. So a profile needs to know one thing — which directory
 * — and the account follows from it. There is no credential to paste, no
 * billing mode to choose (a plan is what Apollo supports), and no backend
 * (Bedrock, Vertex and Foundry went with the credential they authenticated).
 *
 * ## Three steps, in the order the user experiences them
 *
 *  1. **Name it and point it at a directory.** Apollo suggests one inside its
 *     own data directory; the user may replace it with any absolute path,
 *     which is how you attach a profile to the `~/.claude` you are already
 *     signed in to.
 *  2. **Run one command.** Apollo generates it, the user runs it in their own
 *     terminal. Apollo does not spawn it — see `signIn.ts` for why that was
 *     worse.
 *  3. **Apollo notices.** The screen polls the config directory and moves on by
 *     itself when the login lands.
 *
 * Step 3 is what makes step 2 tolerable: nobody has to come back and press a
 * button to tell the app what it can see for itself.
 *
 * ## Two rules that outlived the credential
 *
 *  - **Apollo performs no login.** Unchanged, and now structural rather than a
 *    policy — there is no code here that could grow into one.
 *  - **The directory is the account boundary.** Two profiles pointed at one
 *    directory are one account. That is allowed, because it is occasionally
 *    what someone means.
 */

import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import {
  CheckIcon,
  CopyIcon,
  FolderSearchIcon,
  PlusIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from 'lucide-react';
import { configDirProblem } from '@rx-apollo/protocol';
import type { AuthStatusInfo, ProfileMetadata, ProviderId } from '@rx-apollo/protocol';

import { hasNativeDirectoryPicker, NO_PICKER_REASON, pickDirectory } from '../lib/extensions';
import { shortenPath } from '../lib/paths';
import {
  createProfile,
  deleteProfile,
  readAuthStatus,
  signOutProfile,
  suggestConfigDir,
  updateProfile,
  useApp,
} from '../state/store';
import { IconButton, ReasonButton } from './disabled-reason';
import { CodeBlock, ToneBadge } from './primitives';
import { SettingsPane } from './settings/pane';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

/**
 * How often the sign-in step re-reads the config directory.
 *
 * Each poll spawns a short-lived status subprocess (`claude auth status`,
 * `codex login status`), so this is a trade between "the screen feels dead" and
 * "the machine is busy". Two seconds is comfortably under the time it takes to
 * complete a browser login, and the poll only runs while the sign-in step is
 * actually on screen.
 */
const POLL_INTERVAL_MS = 2_000;

/**
 * Where each provider's CLI keeps its config by default.
 *
 * Used for the directory placeholder and the "point it at your existing one"
 * hint, so a Codex profile is not offered `~/.claude` as an example. Presentation
 * only — the authoritative variable name lives on the adapter's
 * `ProviderCredentialSpec`, which the renderer never sees.
 */
const CONVENTIONAL_CONFIG_DIR: Readonly<Record<ProviderId, string>> = {
  claude: '.claude',
  codex: '.codex',
  opencode: '.config/opencode',
};

export function ProfilesSection(): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeProfileId);
  const [editing, setEditing] = useState<string | null>(null);
  /**
   * Open the create form immediately when there are none.
   *
   * The first-run case: an empty pane with a "New profile" button is a dead end
   * for a user who has no idea what a profile is, and every other pane in this
   * dialog needs one to exist before it can answer anything.
   */
  const [creating, setCreating] = useState(profiles.length === 0);

  return (
    <SettingsPane
      title="Profiles"
      description="Each profile is one provider account and its own history, kept in its own config directory. Switching is manual — Apollo never pools accounts or rotates them for you."
      actions={
        creating ? null : (
          <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
            <PlusIcon />
            New profile
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        {profiles.length === 0 && !creating ? (
          <p className="text-xs text-ink-muted">No profiles yet.</p>
        ) : null}

        {profiles.map((profile) =>
          editing === profile.id ? (
            <ProfileForm
              key={profile.id}
              profile={profile}
              onDone={() => setEditing(null)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <ProfileCard
              key={profile.id}
              profile={profile}
              active={profile.id === activeId}
              onEdit={() => setEditing(profile.id)}
            />
          ),
        )}

        {creating ? <CreateProfileFlow onDone={() => setCreating(false)} /> : null}

        <p className="mt-1 text-2xs leading-relaxed text-ink-faint">
          Apollo stores no credential of any kind. Signing in runs the provider’s own CLI against
          the profile’s config directory, and the credential it writes stays there — Apollo sets one
          environment variable and reads back whether it worked.
        </p>
      </div>
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* Login state                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read one profile's login state, and keep it fresh while `poll` is true.
 *
 * Polling is opt-in per caller rather than always-on: the card list wants one
 * reading on mount, while the sign-in step wants to watch. An always-polling
 * hook would spawn a subprocess per profile per interval for a screen that is
 * usually just sitting there.
 */
function useAuthStatus(
  profileId: string | undefined,
  poll: boolean,
): { readonly status: AuthStatusInfo | undefined; readonly command: string; readonly checking: boolean } {
  const cached = useApp((s) => (profileId === undefined ? undefined : s.authByProfile[profileId]));
  const [command, setCommand] = useState('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (profileId === undefined) return;
    let cancelled = false;

    const read = async (): Promise<void> => {
      setChecking(true);
      const result = await readAuthStatus(profileId);
      if (cancelled) return;
      setChecking(false);
      if (result) setCommand(result.signInCommand);
    };

    void read();
    if (!poll) return () => {
      cancelled = true;
    };

    const timer = setInterval(() => void read(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [profileId, poll]);

  return { status: cached, command, checking };
}

/** One line describing who a directory is signed in as. */
function describeAccount(status: AuthStatusInfo | undefined): string {
  if (!status) return 'checking…';
  if (!status.loggedIn) return status.error ?? 'not signed in';
  const plan = status.subscriptionType ?? status.authMethod;
  return [status.email ?? status.orgName ?? 'signed in', plan].filter(Boolean).join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

function ProfileCard({
  profile,
  active,
  onEdit,
}: {
  readonly profile: ProfileMetadata;
  readonly active: boolean;
  readonly onEdit: () => void;
}): ReactElement {
  const [confirming, setConfirming] = useState(false);
  const [alsoHistory, setAlsoHistory] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const platform = useApp((s) => s.platform);
  const { status } = useAuthStatus(profile.id, signingIn);

  // Undefined means "not read yet", which must not render as signed out — the
  // difference between "we do not know" and "you are not signed in" is the
  // difference between a quiet dash and an amber warning.
  const known = status !== undefined;
  const signedIn = status?.loggedIn === true;

  // Stop watching once the login lands. The step below collapses on its own.
  useEffect(() => {
    if (signedIn) setSigningIn(false);
  }, [signedIn]);

  return (
    <Card size="sm" className={cn('bg-panel ring-1', active ? 'ring-ember/50' : 'ring-line')}>
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{profile.label}</span>
          {active ? <ToneBadge tone="ember">active</ToneBadge> : null}
          {known ? (
            <ToneBadge tone={signedIn ? 'sage' : 'amber'}>
              {signedIn ? 'signed in' : 'signed out'}
            </ToneBadge>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            {/*
              Not an `AlertDialogTrigger asChild`: `IconButton` renders a
              tooltip-wrapped button, and `asChild` needs a single element that
              forwards a ref to the DOM — a Radix `Tooltip.Root` is not one. The
              dialog is controlled instead, which costs one boolean and keeps
              the button's accessible name and tooltip intact.
            */}
            <IconButton
              label="Delete profile"
              size="icon-xs"
              className="text-signal"
              onClick={() => setConfirming(true)}
            >
              <Trash2Icon />
            </IconButton>
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-2xs">
          <span className="text-ink-faint">account</span>
          <span className={known && !signedIn ? 'text-amber' : 'text-ink-muted'}>
            {describeAccount(status)}
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-2xs">
          <span className="text-ink-faint">config</span>
          <span className="min-w-0 truncate text-ink-muted" title={profile.configDir}>
            {shortenPath(profile.configDir, { platform, max: 48 })}
          </span>
        </div>

        {/*
          The sign-in affordance lives on the card, not only in the create
          flow. A credential expires, a user signs out elsewhere, an account
          gets switched — and every one of those leaves an existing profile
          needing exactly the step the create flow ends with.
        */}
        {known && !signedIn && !signingIn ? (
          <div className="mt-1">
            <Button size="xs" variant="outline" onClick={() => setSigningIn(true)}>
              Sign in
            </Button>
          </div>
        ) : null}

        {signingIn ? (
          <div className="mt-1">
            <SignInStep profileId={profile.id} onDone={() => setSigningIn(false)} />
          </div>
        ) : null}

        {/*
          A modal rather than an inline panel. Deleting a profile is
          irreversible, and an inline confirm inside a scrolling list can be
          triggered by a stray click on a row that has since moved.
          `AlertDialog` takes the focus, traps it, and makes Escape mean cancel.

          `alsoHistory` is reset on close, not only on confirm: leaving it on
          would carry a much larger deletion over to whichever profile the user
          opened this on next.
        */}
        <AlertDialog
          open={confirming}
          onOpenChange={(next) => {
            setConfirming(next);
            if (!next) setAlsoHistory(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogMedia className="bg-signal/10 text-signal">
                <TriangleAlertIcon />
              </AlertDialogMedia>
              <AlertDialogTitle className="text-sm text-ink">
                Delete “{profile.label}”?
              </AlertDialogTitle>
              <AlertDialogDescription className="text-2xs leading-relaxed">
                The profile record is removed from Apollo. The config directory it points at —
                including the login inside it — is left alone unless you ask below.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <div className="flex items-start gap-2 rounded-lg border border-line bg-inset/60 px-3 py-2">
              <Switch
                id={`delete-history-${profile.id}`}
                size="sm"
                className="mt-px"
                checked={alsoHistory}
                onCheckedChange={setAlsoHistory}
              />
              <Label
                htmlFor={`delete-history-${profile.id}`}
                className="text-2xs leading-relaxed font-normal text-ink-muted"
              >
                Also delete the config directory and its session history. Apollo only does this for
                directories it created itself — one you chose, such as your own{' '}
                <code className="font-mono">~/.claude</code> or{' '}
                <code className="font-mono">~/.codex</code>, is never deleted.
              </Label>
            </div>

            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Keep it</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                onClick={() => void deleteProfile(profile.id, alsoHistory)}
              >
                Delete profile
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Create                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create, then sign in — one card, two steps.
 *
 * The profile is written to disk between them. That ordering is not incidental:
 * the sign-in command names the config directory, and until the profile exists
 * there is nothing to name or to poll. It also means an interrupted sign-in
 * leaves a real profile that the card list can offer to finish, rather than
 * losing the user's work because they closed a dialog.
 */
function CreateProfileFlow({ onDone }: { readonly onDone: () => void }): ReactElement {
  const [createdId, setCreatedId] = useState<string | null>(null);

  if (createdId === null) {
    return <ProfileForm onDone={setCreatedId} onCancel={onDone} />;
  }

  return (
    <Card size="sm" className="bg-panel ring-1 ring-ember/35">
      <CardContent className="flex flex-col gap-3">
        <h2 className="text-sm font-medium text-ink">Sign in</h2>
        <SignInStep profileId={createdId} onDone={onDone} />
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Sign-in step                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The command, and the wait.
 *
 * Apollo generates the line, the user runs it, and this polls until the config
 * directory says a credential arrived. Nothing here spawns the login — see
 * `@rx-apollo/core`'s `signIn.ts` for the three specific ways that went wrong
 * when it did.
 */
function SignInStep({
  profileId,
  onDone,
}: {
  readonly profileId: string;
  readonly onDone: () => void;
}): ReactElement {
  const { status, command, checking } = useAuthStatus(profileId, true);
  const provider = useApp((s) => s.providers.find((p) => p.id === s.activeProviderId));
  const [copied, setCopied] = useState(false);
  const signedIn = status?.loggedIn === true;

  const copy = useCallback(async (): Promise<void> => {
    if (command.length === 0) return;
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 1_500);
  }, [command]);

  if (signedIn) {
    return (
      <div className="flex flex-col gap-2">
        <Alert className="border-sage/40 bg-sage/5">
          <CheckIcon />
          <AlertTitle className="text-2xs text-sage">Signed in</AlertTitle>
          <AlertDescription className="font-mono text-2xs text-ink-muted">
            {describeAccount(status)}
          </AlertDescription>
        </Alert>
        <div>
          <Button size="sm" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs leading-relaxed text-ink-muted">
        {provider?.signInHowTo ??
          'Run this in a terminal to sign this profile in. Apollo watches its config directory and continues on its own.'}
      </p>

      <div className="flex items-start gap-2">
        <CodeBlock text={command || 'preparing…'} className="min-w-0 flex-1" />
        <Button
          size="xs"
          variant="outline"
          onClick={() => void copy()}
          disabled={command.length === 0}
          aria-label="Copy the sign-in command"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>

      {/*
        A read that *failed* is not the same as a directory that is signed out,
        and the two need different reactions from the user: one means "finish
        the login", the other means "your CLI is not where Apollo can run it".
        Only the second is worth interrupting for.
      */}
      {status?.error ? (
        <Alert variant="destructive" className="border-signal/40 bg-signal/5">
          <TriangleAlertIcon />
          <AlertDescription className="font-mono text-2xs text-signal">
            {status.error}
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-2 text-2xs text-ink-faint">
        {checking ? <Spinner className="size-3" /> : null}
        <span>Waiting for the login to complete — this updates by itself.</span>
        <Button size="xs" variant="ghost" className="ml-auto" onClick={onDone}>
          Finish later
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Form                                                                       */
/* -------------------------------------------------------------------------- */

interface FormProps {
  /** Receives the profile id, so the caller can move on to signing it in. */
  readonly onDone: (profileId: string) => void;
  readonly onCancel: () => void;
  readonly profile?: ProfileMetadata;
}

function ProfileForm({ profile, onDone, onCancel }: FormProps): ReactElement {
  const fallbackProvider = useApp((s) => s.activeProviderId);
  const platform = useApp((s) => s.platform);

  const [label, setLabel] = useState(profile?.label ?? '');
  const [configDir, setConfigDir] = useState(profile?.configDir ?? '');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const editing = profile !== undefined;
  const providerId: ProviderId = profile?.providerId ?? fallbackProvider;
  const native = hasNativeDirectoryPicker();
  const providerLabel = useApp(
    (s) => s.providers.find((p) => p.id === providerId)?.label ?? providerId,
  );
  const homeDirName = CONVENTIONAL_CONFIG_DIR[providerId];

  /**
   * Whether the user has taken ownership of the path.
   *
   * Until they do, the suggestion tracks the label they are typing, so
   * "Work" becomes `…/profiles/work` without anyone having to ask for it. The
   * moment they edit or browse, the suggestion stops moving underneath them —
   * a field that rewrites itself while you are looking at it is worse than one
   * that starts out blank.
   */
  const touched = useRef(editing);

  useEffect(() => {
    if (touched.current) return;
    let cancelled = false;
    void suggestConfigDir(label).then((suggestion) => {
      if (!cancelled && !touched.current && suggestion) setConfigDir(suggestion);
    });
    return () => {
      cancelled = true;
    };
  }, [label]);

  // The same rule the IPC boundary and the profile store apply, applied while
  // the user is still typing, so a path is never accepted here and refused
  // three layers down.
  const pathProblem = configDir.trim().length === 0 ? null : configDirProblem(configDir);

  const browse = async (): Promise<void> => {
    const choice = await pickDirectory(configDir);
    if (choice.status === 'chosen') {
      touched.current = true;
      setConfigDir(choice.path);
      setError(null);
      return;
    }
    // Cancelling is a decision, not a failure. Say nothing.
    if (choice.status === 'cancelled') return;
    setError(choice.message);
  };

  function parseEnv(): Record<string, string> | string {
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return `Cannot parse “${trimmed}”. Use NAME=value, one per line.`;
      env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (label.trim().length === 0) {
      setError('Give the profile a name.');
      return;
    }

    const problem = configDirProblem(configDir);
    if (problem !== null) {
      setError(problem);
      return;
    }

    const env = parseEnv();
    if (typeof env === 'string') {
      setError(env);
      return;
    }

    setBusy(true);
    if (profile) {
      const ok = await updateProfile(profile.id, {
        label: label.trim(),
        configDir: configDir.trim(),
        ...(Object.keys(env).length > 0 ? { publicEnv: env } : {}),
      });
      setBusy(false);
      if (ok) onDone(profile.id);
      return;
    }

    const created = await createProfile({
      label: label.trim(),
      providerId,
      configDir: configDir.trim(),
      ...(Object.keys(env).length > 0 ? { publicEnv: env } : {}),
    });
    setBusy(false);
    // `createProfile` makes the new profile active, which is how the sign-in
    // step below learns which id to poll.
    if (created) {
      const id = useApp.getState().activeProfileId;
      if (id) onDone(id);
    }
  }

  return (
    <Card size="sm" className="bg-panel ring-1 ring-ember/35">
      <CardContent>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup className="gap-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-ink">
                {editing ? 'Edit profile' : 'New profile'}
              </h2>
              {profile ? <ToneBadge>{profile.id.slice(0, 8)}</ToneBadge> : null}
            </div>

            <Field>
              <FieldLabel htmlFor="profile-label" className="text-2xs text-ink-faint uppercase">
                Name
              </FieldLabel>
              <Input
                id="profile-label"
                value={label}
                placeholder="Work"
                autoComplete="off"
                autoFocus={!editing}
                onChange={(event) => setLabel(event.target.value)}
                className="text-xs md:text-xs"
              />
            </Field>

            <Field>
              <FieldLabel htmlFor="profile-config-dir" className="text-2xs text-ink-faint uppercase">
                Config directory
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="profile-config-dir"
                  value={configDir}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={pathProblem !== null}
                  placeholder={
                    platform === 'win32'
                      ? `C:\\Users\\you\\${homeDirName}`
                      : `/Users/you/${homeDirName}`
                  }
                  onChange={(event) => {
                    touched.current = true;
                    setConfigDir(event.target.value);
                    setError(null);
                  }}
                  className="min-w-0 flex-1 font-mono text-xs md:text-xs"
                />
                <ReasonButton
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => void browse()}
                  disabled={!native}
                  disabledReason={native ? undefined : NO_PICKER_REASON}
                  tooltip="Open your system's folder chooser."
                >
                  <FolderSearchIcon />
                  Choose…
                </ReasonButton>
              </div>
              <FieldDescription className="text-2xs">
                {providerLabel} keeps this profile’s login and its session history here. Apollo
                suggests a fresh directory; point it at an existing one — your own{' '}
                <code className="font-mono">~/{homeDirName}</code>, say — to reuse an account you
                are already signed in to.
              </FieldDescription>
              {pathProblem ? (
                <FieldDescription className="text-2xs text-amber">{pathProblem}</FieldDescription>
              ) : null}
            </Field>

            {/*
              Edit only. Creating a profile is meant to be two fields and a
              button; an "extra environment" box on that path is a question
              nobody creating their first profile can answer, and it is
              reachable a click later for the people who do want it.
            */}
            {editing ? (
              <Field>
                <FieldLabel htmlFor="profile-env" className="text-2xs text-ink-faint uppercase">
                  Extra environment (optional)
                </FieldLabel>
                <Textarea
                  id="profile-env"
                  rows={2}
                  value={envText}
                  spellCheck={false}
                  placeholder="ANTHROPIC_MODEL=claude-sonnet-5"
                  onChange={(event) => setEnvText(event.target.value)}
                  className="min-h-14 font-mono text-xs md:text-xs"
                />
                <FieldDescription className="text-2xs">
                  NAME=value per line. Credential-shaped names, and anything that decides where a
                  credential is sent, are rejected.
                </FieldDescription>
              </Field>
            ) : null}

            {error ? (
              <Alert variant="destructive" className="border-signal/40 bg-signal/5">
                <TriangleAlertIcon />
                <AlertDescription className="font-mono text-2xs text-signal">
                  {error}
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy}>
                {editing ? 'Save changes' : 'Create and sign in'}
              </Button>
              <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
              {editing ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="ml-auto text-signal"
                  disabled={busy}
                  onClick={() => void signOutProfile(profile.id)}
                >
                  Sign out
                </Button>
              ) : null}
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
