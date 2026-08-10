/**
 * Profile management.
 * ============================================================================
 *
 * A profile is a named environment bundle: a credential, a hosting backend, an
 * authentication mode, and an isolated config directory. Four rules shape this
 * screen and none of them is negotiable:
 *
 *  1. **A credential travels one way.** The plaintext goes renderer → main
 *     exactly once, on submit, and what comes back is a masked hint. The secret
 *     input below is *uncontrolled*: the value is read from the DOM at submit
 *     time, passed straight to the bridge, and the field is cleared in the same
 *     tick. It is never in React state, never in a store, never in a re-render.
 *
 *  2. **Libra never performs a login.** There is no OAuth flow here, no browser
 *     handoff, no token refresh. Every credential — API key or subscription
 *     token — is one the *user* obtained in their own terminal and pasted in.
 *     The subscription mode's instructions say so in as many words, because
 *     that is the one place a user might reasonably expect a "Sign in" button.
 *
 *  3. **Every picker is built from the provider descriptor.** Backends, auth
 *     modes, and which modes are legal on which backend all come off
 *     `providers:list`. Hard-coding any of them would show Anthropic's options
 *     under a provider that has never heard of them — which is precisely the
 *     bug that moved these lists behind the seam in the first place.
 *
 *  4. **The billing difference is stated, not implied.** An API key bills
 *     metered API usage; a subscription token bills a plan. The two travel in
 *     different environment variables and one silently overrides the other, so
 *     the profile must say which it means and the user must be able to see
 *     which they chose without guessing.
 */

import { useRef, useState, type FormEvent, type ReactElement } from 'react';
import { KeyRoundIcon, PlusIcon, Trash2Icon, TriangleAlertIcon, XIcon } from 'lucide-react';
import { credentialShapeWarning, isCredentialRoutingEnvKey, isSecretEnvKey } from '@libra/protocol';
import type {
  ProfileMetadata,
  ProviderAuthModeOption,
  ProviderBackend,
  ProviderId,
} from '@libra/protocol';

import {
  authModeSupportsBackend,
  authModesOf,
  describeCredential,
  needsSecret,
  resolveAuthMode,
  resolveBackend,
} from '../lib/authModes';
import { createProfile, deleteProfile, setScreen, updateProfile, useApp } from '../state/store';
import { IconButton, WithReason } from './disabled-reason';
import { ToneBadge } from './primitives';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

export function ProfilesScreen(): ReactElement {
  const profiles = useApp((s) => s.profiles);
  const activeId = useApp((s) => s.activeProfileId);
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(profiles.length === 0);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-abyss">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line bg-panel px-3">
        <KeyRoundIcon className="size-3.5 text-brass" aria-hidden="true" />
        <h1 className="text-sm font-semibold tracking-tight text-ink">Profiles</h1>
        <p className="ml-2 hidden text-2xs text-ink-faint md:block">
          Each profile is its own credential and its own isolated history. Switching is manual —
          Libra never pools accounts or rotates them for you.
        </p>
        <IconButton label="Close (Esc)" className="ml-auto" onClick={() => setScreen('chat')}>
          <XIcon />
        </IconButton>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-5">
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

          {creating ? (
            <ProfileForm onDone={() => setCreating(false)} onCancel={() => setCreating(false)} />
          ) : (
            <div>
              <Button variant="outline" onClick={() => setCreating(true)}>
                <PlusIcon />
                New profile
              </Button>
            </div>
          )}

          <p className="mt-2 text-2xs leading-relaxed text-ink-faint">
            Credentials are stored by the main process in the operating system’s encrypted
            credential store. The interface you are looking at only ever receives a masked hint — it
            has no way to read one back, and nothing on this screen can be reversed into one.
          </p>
        </div>
      </ScrollArea>
    </div>
  );
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
  const provider = useApp((s) => s.providers.find((p) => p.id === profile.providerId));

  // An absent backend or mode means "this provider's default", so both are
  // named from the provider's own lists rather than assumed.
  const backend = resolveBackend(provider, profile.backend);
  const authMode = resolveAuthMode(provider, profile.backend, profile.authMode);
  const credential = describeCredential(backend, authMode);

  return (
    <Card size="sm" className={cn('bg-panel ring-1', active ? 'ring-brass/50' : 'ring-line')}>
      <CardContent className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-ink">{profile.label}</span>
          {active ? <ToneBadge tone="brass">active</ToneBadge> : null}
          <ToneBadge>{profile.providerId}</ToneBadge>
          {backend ? <ToneBadge tone="cyan">{backend.label}</ToneBadge> : null}
          {credential ? (
            <ToneBadge tone={credential.usesStoredSecret ? 'sage' : 'neutral'}>
              {credential.label}
            </ToneBadge>
          ) : null}
          <span className="ml-auto flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
            <IconButton
              label="Delete profile"
              size="icon-xs"
              className="text-signal"
              onClick={() => setConfirming((v) => !v)}
            >
              <Trash2Icon />
            </IconButton>
          </span>
        </div>

        <div className="flex items-center gap-2 font-mono text-2xs">
          <span className="text-ink-faint">credential</span>
          <span
            className={cn(
              // Amber only when a credential is *missing and needed*. A profile
              // on an ambient-chain backend legitimately has none.
              profile.keyHint
                ? 'text-ink-muted'
                : credential?.usesStoredSecret
                  ? 'text-amber'
                  : 'text-ink-faint',
            )}
          >
            {profile.keyHint ?? 'none stored'}
          </span>
        </div>

        {credential ? (
          <p className="text-2xs leading-snug text-ink-faint">{credential.note}</p>
        ) : null}

        {confirming ? (
          <Alert variant="destructive" className="mt-1 border-signal/40 bg-signal/5">
            <TriangleAlertIcon />
            <AlertTitle className="text-2xs">Delete “{profile.label}”?</AlertTitle>
            <AlertDescription className="text-2xs text-signal/90">
              <p>The stored credential is destroyed immediately and cannot be recovered.</p>
              <div className="mt-1.5 flex items-center gap-2">
                <Switch
                  id={`delete-history-${profile.id}`}
                  size="sm"
                  checked={alsoHistory}
                  onCheckedChange={setAlsoHistory}
                />
                <Label
                  htmlFor={`delete-history-${profile.id}`}
                  className="text-2xs font-normal text-ink-muted"
                >
                  also delete this profile’s isolated config directory and its session history
                </Label>
              </div>
              <div className="mt-2 flex gap-2">
                <Button
                  size="xs"
                  variant="destructive"
                  onClick={() => void deleteProfile(profile.id, alsoHistory)}
                >
                  Delete profile
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Form                                                                       */
/* -------------------------------------------------------------------------- */

interface FormProps {
  readonly profile?: ProfileMetadata;
  readonly onDone: () => void;
  readonly onCancel: () => void;
}

function ProfileForm({ profile, onDone, onCancel }: FormProps): ReactElement {
  const providers = useApp((s) => s.providers);
  const fallbackProvider = useApp((s) => s.activeProviderId);

  const [label, setLabel] = useState(profile?.label ?? '');
  const [providerId, setProviderId] = useState<ProviderId>(profile?.providerId ?? fallbackProvider);
  const [backendId, setBackendId] = useState<ProviderBackend | ''>(profile?.backend ?? '');
  const [authModeId, setAuthModeId] = useState<string>(profile?.authMode ?? '');
  const [envText, setEnvText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * A soft warning about the pasted credential's shape.
   *
   * Advisory only — see `credentialShapeWarning`. Without it a malformed
   * credential saves silently and fails later as `401 invalid bearer token`,
   * which gives the user nothing to act on.
   */
  const [shapeWarning, setShapeWarning] = useState<string | null>(null);

  const provider = providers.find((p) => p.id === providerId);
  const backends = provider?.backends ?? [];
  const modes = authModesOf(provider);

  const selectedBackend = resolveBackend(provider, backendId === '' ? undefined : backendId);
  /**
   * The mode that will actually be used.
   *
   * Not simply "whatever is in `authModeId`": a mode may be legal on one
   * backend and meaningless on another, so switching the backend can invalidate
   * the current choice. Rather than silently submitting an impossible pair —
   * which the credential resolver would refuse — the fallback is computed here
   * and the substitution is announced below the picker.
   */
  const selectedMode = resolveAuthMode(
    provider,
    selectedBackend?.id,
    authModeId === '' ? undefined : authModeId,
  );
  const modeWasSubstituted =
    authModeId !== '' && selectedMode !== undefined && selectedMode.id !== authModeId;

  /**
   * The credential input is uncontrolled on purpose — see the file header.
   * React never sees the value; it is read once, sent, and wiped.
   */
  const keyRef = useRef<HTMLInputElement>(null);

  const editing = profile !== undefined;
  const secretRequired = needsSecret(selectedBackend, selectedMode);
  const secretLabel = selectedMode?.label ?? 'API key';
  /**
   * Worth warning about only when a stored credential is actually in play.
   * On a backend with an ambient credential chain the mode is still recorded
   * but nothing Libra holds is read, so "your credential will not be migrated"
   * would be a warning about an event that cannot happen.
   */
  const changingMode =
    editing && secretRequired && selectedMode !== undefined && profile.authMode !== selectedMode.id;

  function parseEnv(): Record<string, string> | string {
    const env: Record<string, string> = {};
    for (const line of envText.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return `Cannot parse “${trimmed}”. Use NAME=value, one per line.`;
      const name = trimmed.slice(0, eq).trim();
      // The store refuses credential-shaped names, and so does this form: a
      // credential pasted here would land in an unencrypted file.
      if (isSecretEnvKey(name)) {
        return `${name} looks like a credential. Put secrets in the credential field, not here.`;
      }
      // Likewise for names that decide where the credential is *sent*. The main
      // process rejects these regardless — this only turns a round-trip error
      // into an immediate one.
      if (isCredentialRoutingEnvKey(name)) {
        return `${name} controls where your credential is sent, which Libra decides. Remove it.`;
      }
      env[name] = trimmed.slice(eq + 1).trim();
    }
    return env;
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    setError(null);

    if (label.trim().length === 0) {
      setError('Give the profile a label.');
      return;
    }

    const env = parseEnv();
    if (typeof env === 'string') {
      setError(env);
      return;
    }

    // Read the credential out of the DOM and clear the field in the same
    // statement block. From here it lives only in this local, for the duration
    // of one await, and is never handed to React.
    const input = keyRef.current;
    const secret = input?.value ?? '';
    if (input) input.value = '';

    if (!editing && secretRequired && secret.trim().length === 0) {
      setError(`The ${secretLabel} mode on ${selectedBackend?.label ?? 'this backend'} needs a credential.`);
      return;
    }

    // Omitted rather than guessed: an absent backend or mode means "this
    // provider's default", which the provider itself resolves.
    const chosenBackend = selectedBackend?.id;
    const chosenMode = selectedMode?.id;

    setBusy(true);
    const okResult = profile
      ? await updateProfile(profile.id, {
          label: label.trim(),
          ...(chosenBackend === undefined ? {} : { backend: chosenBackend }),
          ...(chosenMode === undefined ? {} : { authMode: chosenMode }),
          ...(secret.trim().length > 0 ? { apiKey: secret.trim() } : {}),
          ...(Object.keys(env).length > 0 ? { publicEnv: env } : {}),
        })
      : await createProfile({
          label: label.trim(),
          providerId,
          ...(chosenBackend === undefined ? {} : { backend: chosenBackend }),
          ...(chosenMode === undefined ? {} : { authMode: chosenMode }),
          ...(secret.trim().length > 0 ? { apiKey: secret.trim() } : {}),
          ...(Object.keys(env).length > 0 ? { publicEnv: env } : {}),
        });
    setBusy(false);
    if (okResult) onDone();
  }

  return (
    <Card size="sm" className="bg-panel ring-1 ring-brass/35">
      <CardContent>
        <form onSubmit={(event) => void submit(event)}>
          <FieldGroup className="gap-4">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-ink">
                {editing ? 'Edit profile' : 'New profile'}
              </h2>
              {profile ? <ToneBadge>{profile.id.slice(0, 8)}</ToneBadge> : null}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Field>
                <FieldLabel htmlFor="profile-label" className="text-2xs text-ink-faint uppercase">
                  Label
                </FieldLabel>
                <Input
                  id="profile-label"
                  value={label}
                  placeholder="Work — Bedrock"
                  autoComplete="off"
                  onChange={(event) => setLabel(event.target.value)}
                  className="font-mono text-xs md:text-xs"
                />
              </Field>

              <Field>
                <FieldLabel htmlFor="profile-provider" className="text-2xs text-ink-faint uppercase">
                  Provider
                </FieldLabel>
                {/* Locked while editing: the provider decides the shape of
                    everything below it, and a profile that changed providers
                    would keep a credential minted for a different service. */}
                <WithReason
                  reason={editing ? 'A profile cannot change provider. Create a new one.' : undefined}
                  className="w-full"
                >
                  <Select
                    value={providerId}
                    disabled={editing}
                    onValueChange={(value) => {
                      setProviderId(value as ProviderId);
                      setBackendId('');
                      setAuthModeId('');
                    }}
                  >
                    <SelectTrigger id="profile-provider" className="w-full text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(providers.length > 0
                        ? providers.map((p) => ({ id: p.id, label: p.label }))
                        : [{ id: providerId, label: providerId }]
                      ).map((option) => (
                        <SelectItem key={option.id} value={option.id} className="text-xs">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </WithReason>
              </Field>

              <Field>
                <FieldLabel htmlFor="profile-backend" className="text-2xs text-ink-faint uppercase">
                  Backend
                </FieldLabel>
                <WithReason
                  reason={
                    backends.length === 0
                      ? 'This provider does not offer a backend choice.'
                      : undefined
                  }
                  className="w-full"
                >
                  <Select
                    value={selectedBackend?.id ?? ''}
                    disabled={backends.length === 0}
                    onValueChange={setBackendId}
                  >
                    <SelectTrigger id="profile-backend" className="w-full text-xs">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      {backends.map((option) => (
                        <SelectItem key={option.id} value={option.id} className="text-xs">
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </WithReason>
                <FieldDescription className="text-2xs">
                  {selectedBackend?.note ?? 'Where the models are hosted.'}
                </FieldDescription>
              </Field>
            </div>

            {modes.length > 0 ? (
              <AuthModeField
                modes={modes}
                selected={selectedMode}
                backendId={selectedBackend?.id}
                backendLabel={selectedBackend?.label}
                substituted={modeWasSubstituted}
                secretRequired={secretRequired}
                onChange={setAuthModeId}
              />
            ) : null}

            <Field>
              <FieldLabel htmlFor="profile-key" className="text-2xs text-ink-faint uppercase">
                {editing ? `Replace ${secretLabel.toLowerCase()}` : secretLabel}
              </FieldLabel>
              <Input
                id="profile-key"
                ref={keyRef}
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder={secretRequired ? 'paste it here' : 'not required for this backend'}
                defaultValue=""
                className="font-mono text-xs md:text-xs"
                onChange={(e) => setShapeWarning(credentialShapeWarning(e.target.value, selectedMode?.id))}
              />
              <FieldDescription className="text-2xs">
                {editing
                  ? 'Leave blank to keep the stored credential. Anything typed here replaces it.'
                  : 'Sent straight to encrypted storage. Libra shows you a masked hint afterwards and cannot read it back.'}
              </FieldDescription>
              {selectedMode?.secretHowTo ? (
                <FieldDescription className="text-2xs text-ink-muted">
                  {selectedMode.secretHowTo}
                </FieldDescription>
              ) : null}
              {/*
                Advisory, not blocking: the save button stays enabled. Vendor
                prefixes are a convention rather than a contract, so this warns
                and gets out of the way.
              */}
              {shapeWarning ? (
                <FieldDescription className="text-2xs text-amber">{shapeWarning}</FieldDescription>
              ) : null}
            </Field>

            {changingMode ? (
              <Alert className="border-amber/40 bg-amber/5 text-amber">
                <TriangleAlertIcon />
                <AlertTitle className="text-2xs">
                  Switching to “{selectedMode?.label}” changes what is billed
                </AlertTitle>
                <AlertDescription className="text-2xs text-amber/85">
                  The stored credential is not migrated — a key is not a subscription token. Enter
                  the credential for the new mode above, or this profile will have none.
                </AlertDescription>
              </Alert>
            ) : null}

            <Field>
              <FieldLabel htmlFor="profile-env" className="text-2xs text-ink-faint uppercase">
                Extra environment (optional)
              </FieldLabel>
              <Textarea
                id="profile-env"
                rows={2}
                value={envText}
                spellCheck={false}
                placeholder="AWS_REGION=us-east-1"
                onChange={(event) => setEnvText(event.target.value)}
                className="min-h-14 font-mono text-xs md:text-xs"
              />
              <FieldDescription className="text-2xs">
                NAME=value per line. Credential-shaped names, and anything that decides where a
                credential is sent, are rejected here.
              </FieldDescription>
            </Field>

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
                {editing ? 'Save changes' : 'Create profile'}
              </Button>
              <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
                Cancel
              </Button>
            </div>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* Auth mode                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The auth-mode picker.
 *
 * Modes that are illegal on the selected backend are rendered **disabled with
 * the reason inline**, never removed. A user hunting for "Claude subscription"
 * under Bedrock has to be able to see that it exists and learn that it belongs
 * to the Anthropic API — a list that silently shortens teaches nothing.
 */
function AuthModeField({
  modes,
  selected,
  backendId,
  backendLabel,
  substituted,
  secretRequired,
  onChange,
}: {
  readonly modes: readonly ProviderAuthModeOption[];
  readonly selected: ProviderAuthModeOption | undefined;
  readonly backendId: string | undefined;
  readonly backendLabel: string | undefined;
  readonly substituted: boolean;
  readonly secretRequired: boolean;
  readonly onChange: (id: string) => void;
}): ReactElement {
  return (
    <Field>
      <FieldLabel htmlFor="profile-auth-mode" className="text-2xs text-ink-faint uppercase">
        Authentication &amp; billing
      </FieldLabel>
      <Select value={selected?.id ?? ''} onValueChange={onChange}>
        <SelectTrigger id="profile-auth-mode" className="w-full text-xs sm:w-80">
          <SelectValue placeholder="provider default" />
        </SelectTrigger>
        <SelectContent>
          {modes.map((mode) => {
            const allowed = authModeSupportsBackend(mode, backendId);
            return (
              <SelectItem
                key={mode.id}
                value={mode.id}
                disabled={!allowed}
                className="text-xs"
              >
                <span className="flex items-center gap-1.5">
                  {mode.label}
                  {allowed ? null : (
                    <span className="font-mono text-2xs text-amber">
                      {mode.backends?.join(', ')} only
                    </span>
                  )}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>

      {/* On an ambient-chain backend the mode is still recorded, but nothing
          Libra stores is read and the mode's billing note would describe an
          account that is not being charged. Say which it is. */}
      {!secretRequired ? (
        <FieldDescription className="text-2xs text-ink-muted">
          {backendLabel ?? 'This backend'} authenticates from its own credential chain, so this
          choice does not decide what is billed.
        </FieldDescription>
      ) : selected ? (
        <FieldDescription className="text-2xs text-ink-muted">{selected.note}</FieldDescription>
      ) : null}

      {substituted ? (
        <FieldDescription className="text-2xs text-amber">
          The mode you had chosen is not available on {backendLabel ?? 'this backend'}, so
          “{selected?.label}” will be used instead.
        </FieldDescription>
      ) : null}

      {/*
        The one place a user might reasonably expect a "Sign in with Claude"
        button. There is not one today: Libra holds credentials the user
        brought, and performs no interactive login of any kind.

        This is contingent, not architectural. Anthropic's Agent SDK terms do
        not permit a third-party product to offer claude.ai login or
        subscription rate limits "unless previously approved" — so the bar is
        approval, not feasibility. If Libra obtains that approval, an in-app
        login becomes legitimate and this decision should be revisited.

        Two things would change with it, and both are the reason paste-a-token
        is the better default until then: Libra would have to run the OAuth
        handshake, and it would have to store and refresh a refresh token
        rather than holding one long-lived credential in the keychain.
      */}
      {secretRequired ? (
        <FieldDescription className="text-2xs">
          Libra does not sign you in. Obtain the credential yourself and paste it below — nothing on
          this screen opens a browser or talks to an account.
        </FieldDescription>
      ) : null}
    </Field>
  );
}
