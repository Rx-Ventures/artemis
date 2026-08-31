/**
 * Key managers — where Artemis gets secrets instead of keeping them.
 * ============================================================================
 *
 * Every other pane in this dialog configures something Artemis does. This one
 * configures something Artemis stops doing: a machine with a manager connected
 * here can point a memory bank at a *reference* instead of pasting a token, so
 * the token stays in the manager, rotates in the manager, and is never on this
 * disk at all. The pane's job is to make the one credential it does keep — the
 * manager's own — obviously worth it.
 *
 * ---------------------------------------------------------------------------
 * THE FORM IS BUILT FROM THE PROVIDER, NOT FROM A SWITCH
 * ---------------------------------------------------------------------------
 *
 * OpenBao wants an address, a username and a password; Doppler wants a token
 * and nothing else. Both field lists arrive with the connection listing as
 * {@link SecretProviderDescriptor}s and are rendered generically. The
 * alternative — `provider === 'openbao' ? … : …` in the JSX — is how the
 * second provider ends up supported in three places and forgotten in a fourth,
 * and there is a third provider coming for anyone who reads this later.
 *
 * ---------------------------------------------------------------------------
 * A CERTIFICATE IS TRUSTED BY A PERSON, IN THIS PANE, OR NOT AT ALL
 * ---------------------------------------------------------------------------
 *
 * Self-hosted managers usually run on a private CA, so the *first* verify of a
 * real OpenBao usually fails on TLS. That failure is the one this pane can
 * remedy in place: it offers to fetch the server's certificate — a handshake,
 * no request; see `main/secretManagers.ts` — and shows the fingerprint, the
 * SANs and the expiry. The user reads them, and only then does "Trust this
 * certificate" store the PEM and re-verify.
 *
 * Everything in that sequence is deliberate. The app never pins silently, the
 * evidence is on screen *before* the button that acts on it, and the button
 * says what it does rather than "Continue".
 *
 * ---------------------------------------------------------------------------
 * WHAT THE ROWS SHOW, AND WHY IT IS NOT JUST A TICK
 * ---------------------------------------------------------------------------
 *
 * "Reachable" tells a user nothing about *whose* authority they proved. So a
 * verified row carries the identity the manager reported, its policies, and
 * its expiry — the three facts that turn a green tick into something that can
 * be wrong in a way you can see. A degraded row says which kind of degraded:
 * a standby OpenBao node reports itself with the status code every HTTP client
 * reads as rate limiting, and calling that "throttled" would be repeating the
 * manager's most confusing quirk to the user.
 */

import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type {
  SecretAuthMethod,
  SecretConnectionState,
  SecretField,
  SecretProviderDescriptor,
  SecretProviderId,
  SecretServerCertificate,
  SecretVerifyResult,
} from '@rx-artemis/protocol';

import { useSecretManagers, type SecretManagersPane } from '../../hooks/useSecretManagers';
import { CodeBlock, Row, ToneBadge } from '../primitives';
import { SettingsGroup, SettingsPane } from './pane';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function KeyManagersSection(): ReactElement {
  const pane = useSecretManagers();

  return (
    <SettingsPane
      title="Key managers"
      description="Connect OpenBao or Doppler, and point a memory bank at a secret instead of pasting one. The value is fetched when it is needed and never stored here."
      actions={
        pane.connections.length > 0 ? (
          <Button size="sm" variant="outline" disabled={pane.busy !== null} onClick={pane.refresh}>
            Re-read
          </Button>
        ) : undefined
      }
    >
      {pane.error !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{pane.error}</p>
      ) : null}

      {pane.reading && pane.connections.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">Reading the configured managers…</p>
      ) : null}

      {pane.connections.length > 0 ? <ConnectionsGroup pane={pane} /> : null}
      <AddGroup pane={pane} first={pane.connections.length === 0} />

      {pane.lastAction !== null ? (
        <CodeBlock text={pane.lastAction} tone="neutral" className="max-h-32" />
      ) : null}
    </SettingsPane>
  );
}

/* -------------------------------------------------------------------------- */
/* The configured connections                                                 */
/* -------------------------------------------------------------------------- */

function ConnectionsGroup({ pane }: { readonly pane: SecretManagersPane }): ReactElement {
  return (
    <SettingsGroup label="Connected">
      {pane.connections.map((state) => (
        <ConnectionCard key={state.connection.id} pane={pane} state={state} />
      ))}
    </SettingsGroup>
  );
}

/** What the row's badge says, and in what colour. */
function verdict(state: SecretConnectionState): { tone: 'mint' | 'amber' | 'signal'; label: string } {
  const last = state.lastVerify;
  if (last === null) return { tone: 'amber', label: 'not checked' };
  if (last.result.degraded === 'standby') return { tone: 'amber', label: 'standby node' };
  if (last.result.degraded === 'sealed') return { tone: 'signal', label: 'sealed' };
  if (last.result.degraded === 'rate-limited') return { tone: 'amber', label: 'rate-limited' };
  if (last.result.ok) return { tone: 'mint', label: 'working' };
  return { tone: 'signal', label: last.result.problem ?? 'not working' };
}

function ConnectionCard({
  pane,
  state,
}: {
  readonly pane: SecretManagersPane;
  readonly state: SecretConnectionState;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [certificate, setCertificate] = useState<SecretServerCertificate | null>(null);
  const [certificateProblem, setCertificateProblem] = useState<string | null>(null);
  const { connection, lastVerify } = state;
  const badge = verdict(state);
  const provider = pane.providers.find((entry) => entry.id === connection.provider);

  /**
   * The remedy this pane can actually apply, offered only where it applies.
   *
   * A certificate button on a row that failed because the password was wrong
   * would be an invitation to trust a server about an unrelated problem.
   */
  const offersCertificate =
    lastVerify?.result.problem === 'tls' && connection.address.startsWith('https://');

  const fetchCertificate = async (): Promise<void> => {
    setCertificateProblem(null);
    const result = await pane.fetchCertificate(connection.address);
    if (result.ok) setCertificate(result.value);
    else setCertificateProblem(result.error.message);
  };

  const trustCertificate = async (): Promise<void> => {
    if (certificate === null) return;
    await pane.save({
      id: connection.id,
      label: connection.label,
      provider: connection.provider,
      address: connection.address,
      caPem: certificate.pem,
      authMethod: connection.authMethod,
      ...(connection.username === undefined ? {} : { username: connection.username }),
    });
    setCertificate(null);
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-line bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink">{connection.label}</span>
        <ToneBadge tone="neutral">{provider?.label ?? connection.provider}</ToneBadge>
        <ToneBadge tone={badge.tone}>{badge.label}</ToneBadge>
        {connection.caPem !== undefined ? (
          <ToneBadge tone="cyan">pinned certificate</ToneBadge>
        ) : null}
        {!state.hasCredential ? <ToneBadge tone="amber">no credential</ToneBadge> : null}
      </div>

      <Row label="address">{connection.address}</Row>
      {connection.username !== undefined ? (
        <Row label="username">{connection.username}</Row>
      ) : null}
      {lastVerify?.result.identity !== undefined ? (
        <Row label="identity">{lastVerify.result.identity}</Row>
      ) : null}
      {lastVerify?.result.policies !== undefined && lastVerify.result.policies.length > 0 ? (
        <Row label="policies">{lastVerify.result.policies.join(', ')}</Row>
      ) : null}
      {lastVerify?.result.expiresAt !== undefined ? (
        <Row label="expires">{lastVerify.result.expiresAt}</Row>
      ) : null}
      {lastVerify !== null ? (
        <p className="text-2xs leading-relaxed text-ink-faint">{lastVerify.result.detail}</p>
      ) : (
        <p className="text-2xs leading-relaxed text-ink-faint">
          This connection has not been checked since Artemis started. Verify it to see whose
          authority it carries and when it expires.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="text-2xs"
          disabled={pane.busy !== null}
          onClick={() => void pane.verify(connection.id)}
        >
          {pane.busy === 'verify' ? 'Checking…' : 'Verify'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="text-2xs"
          disabled={pane.busy !== null}
          onClick={() => setEditing((open) => !open)}
        >
          {editing ? 'Cancel' : 'Edit'}
        </Button>
        {offersCertificate ? (
          <Button
            size="sm"
            variant="outline"
            className="text-2xs"
            disabled={pane.busy !== null}
            onClick={() => void fetchCertificate()}
          >
            {pane.busy === 'certificate' ? 'Fetching…' : "Fetch the server's certificate"}
          </Button>
        ) : null}
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button size="sm" variant="ghost" className="text-2xs text-signal" disabled={pane.busy !== null}>
              Remove
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove “{connection.label}”?</AlertDialogTitle>
              <AlertDialogDescription>
                Its stored credential is deleted with it. Anything pointing at this connection — a
                memory bank holding a reference rather than a token — stops resolving, and will say
                so the next time it syncs.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={() => void pane.remove(connection.id)}>
                Remove the connection
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {certificateProblem !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{certificateProblem}</p>
      ) : null}
      {certificate !== null ? (
        <CertificateOffer
          certificate={certificate}
          busy={pane.busy !== null}
          onTrust={() => void trustCertificate()}
          onDismiss={() => setCertificate(null)}
        />
      ) : null}

      {editing && provider !== undefined ? (
        <ConnectionForm
          pane={pane}
          provider={provider}
          existing={connection}
          onDone={() => setEditing(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * The evidence, then the button that acts on it — in that order on screen.
 *
 * Nothing has been trusted at the point this renders. A handshake happened, a
 * certificate came back, and it is being shown to a person who is about to
 * decide. That is why the fingerprint is the largest thing here and why the
 * confirming button names the act rather than saying "OK": a user who clicks
 * past this has still been shown exactly what they accepted.
 */
function CertificateOffer({
  certificate,
  busy,
  onTrust,
  onDismiss,
}: {
  readonly certificate: SecretServerCertificate;
  readonly busy: boolean;
  readonly onTrust: () => void;
  readonly onDismiss: () => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-amber/40 bg-amber/5 px-3 py-2.5">
      <p className="text-2xs leading-relaxed text-ink-muted">
        This is the certificate that server presented. Nothing has been trusted yet. Check the
        fingerprint against the one your administrator gave you — if it does not match, do not
        trust it.
      </p>
      <Row label="sha-256">{certificate.fingerprintSha256}</Row>
      <Row label="subject">{certificate.subject}</Row>
      <Row label="issuer">{certificate.issuer}</Row>
      <Row label="names">{certificate.san.join(', ') || '(none)'}</Row>
      <Row label="expires">{certificate.notAfter}</Row>
      {certificate.selfSigned ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          It is self-signed, so this exact certificate is what gets pinned. It will have to be
          replaced here when the server renews it.
        </p>
      ) : (
        <p className="text-2xs leading-relaxed text-ink-faint">
          Its issuer is what gets stored, so this keeps working when the server renews.
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={onTrust}>
          Trust this certificate
        </Button>
        <Button size="sm" variant="ghost" className="text-2xs" disabled={busy} onClick={onDismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Adding and editing                                                         */
/* -------------------------------------------------------------------------- */

function AddGroup({
  pane,
  first,
}: {
  readonly pane: SecretManagersPane;
  readonly first: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [providerId, setProviderId] = useState<SecretProviderId>('openbao');
  const provider = pane.providers.find((entry) => entry.id === providerId);

  return (
    <SettingsGroup label={first ? 'Set up' : 'Add a manager'}>
      {first ? (
        <p className="text-2xs leading-relaxed text-ink-muted">
          No key manager is connected. Connect one and Artemis can stop storing your git tokens:
          a memory bank points at a secret&apos;s address instead, the value is fetched in the
          background when git needs it, and rotating it in the manager is all the rotation there
          is. The manager&apos;s own credential is the only one kept here, encrypted.
        </p>
      ) : null}

      {!open ? (
        <div>
          <Button size="sm" disabled={pane.busy !== null} onClick={() => setOpen(true)}>
            {first ? 'Connect a key manager' : 'Add a manager'}
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2 rounded-md border border-line bg-panel px-3 py-2.5">
          <div className="flex items-center gap-1">
            {pane.providers.map((candidate) => (
              <Button
                key={candidate.id}
                size="sm"
                variant={providerId === candidate.id ? 'default' : 'ghost'}
                className="text-2xs"
                onClick={() => setProviderId(candidate.id)}
              >
                {candidate.label}
              </Button>
            ))}
          </div>
          {provider !== undefined ? (
            <>
              <p className="text-2xs leading-relaxed text-ink-faint">{provider.note}</p>
              <ConnectionForm pane={pane} provider={provider} onDone={() => setOpen(false)} />
            </>
          ) : (
            <p className="text-2xs leading-relaxed text-ink-faint">Reading the providers…</p>
          )}
        </div>
      )}
    </SettingsGroup>
  );
}

/**
 * One connection's form, generated from its provider's declared fields.
 *
 * The credential is component state and nothing else: it goes into one save
 * and is cleared the moment that returns. It is never put in the pane hook
 * (which outlives the form), never in the app store, and never read back from
 * main — for `userpass`, main spends the password on a login and stores only
 * the token it minted, so there is nothing to read back.
 */
function ConnectionForm({
  pane,
  provider,
  existing,
  onDone,
}: {
  readonly pane: SecretManagersPane;
  readonly provider: SecretProviderDescriptor;
  readonly existing?: SecretConnectionState['connection'];
  readonly onDone: () => void;
}): ReactElement {
  const [label, setLabel] = useState(existing?.label ?? '');
  const [authMethod, setAuthMethod] = useState<SecretAuthMethod>(
    existing?.authMethod ?? provider.authMethods[0] ?? 'token',
  );
  const [values, setValues] = useState<Record<string, string>>({
    address: existing?.address ?? '',
    username: existing?.username ?? '',
  });
  const [credential, setCredential] = useState('');
  const [certificate, setCertificate] = useState<SecretServerCertificate | null>(null);
  const [certificateProblem, setCertificateProblem] = useState<string | null>(null);
  const [verify, setVerify] = useState<SecretVerifyResult | null>(null);

  const shown = useMemo(
    () =>
      provider.configFields.filter(
        (field) => field.onlyForAuthMethod === undefined || field.onlyForAuthMethod === authMethod,
      ),
    [provider.configFields, authMethod],
  );

  const missing = shown.some((field) => field.required && (values[field.id] ?? '').trim().length === 0);
  const ready = label.trim().length > 0 && !missing;

  const submit = async (caPem?: string): Promise<void> => {
    const trimmedCredential = credential.trim();
    const answer = await pane.save({
      ...(existing === undefined ? {} : { id: existing.id }),
      label: label.trim(),
      provider: provider.id,
      address: (values['address'] ?? '').trim(),
      ...(caPem !== undefined
        ? { caPem }
        : existing?.caPem === undefined
          ? {}
          : { caPem: existing.caPem }),
      authMethod,
      ...((values['username'] ?? '').trim().length > 0
        ? { username: (values['username'] ?? '').trim() }
        : {}),
      ...(trimmedCredential.length === 0
        ? {}
        : {
            credential:
              authMethod === 'userpass' ? { password: credential } : { token: credential },
          }),
    });
    setVerify(answer);
    // Cleared whichever way the save went. The credential has done its one job
    // — main either stored it or minted from it — and a copy left in a mounted
    // form is a copy nothing needs.
    setCredential('');
    if (answer !== null && answer.ok) onDone();
  };

  const offersCertificate =
    verify?.problem === 'tls' && (values['address'] ?? '').startsWith('https://');

  const fetchCertificate = async (): Promise<void> => {
    setCertificateProblem(null);
    const result = await pane.fetchCertificate((values['address'] ?? '').trim());
    if (result.ok) setCertificate(result.value);
    else setCertificateProblem(result.error.message);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="what you call it (e.g. work vault)"
          spellCheck={false}
          className="w-56 text-xs md:text-xs"
          aria-label="Connection label"
        />
        {provider.authMethods.length > 1
          ? provider.authMethods.map((method) => (
              <Button
                key={method}
                size="sm"
                variant={authMethod === method ? 'default' : 'ghost'}
                className="text-2xs"
                onClick={() => setAuthMethod(method)}
              >
                {method === 'userpass' ? 'Username and password' : 'Paste a token'}
              </Button>
            ))
          : null}
      </div>

      {shown.map((field) => (
        <FieldInput
          key={field.id}
          field={field}
          value={values[field.id] ?? ''}
          onChange={(next) => setValues((current) => ({ ...current, [field.id]: next }))}
        />
      ))}

      <div className="flex flex-col gap-1">
        <Input
          type="password"
          value={credential}
          onChange={(event) => setCredential(event.target.value)}
          placeholder={
            authMethod === 'userpass'
              ? existing === undefined
                ? 'password'
                : 'password (leave empty to keep the stored token)'
              : existing === undefined
                ? 'token'
                : 'token (leave empty to keep the stored one)'
          }
          autoComplete="off"
          spellCheck={false}
          className="w-80 text-xs md:text-xs"
          aria-label={authMethod === 'userpass' ? 'Password' : 'Token'}
        />
        <p className="text-2xs leading-relaxed text-ink-faint">
          {authMethod === 'userpass'
            ? 'Used once, here, to mint a token. The password is never written down — when the token expires this pane will ask for it again.'
            : 'Stored encrypted on this machine and used only to reach this manager.'}
        </p>
      </div>

      {verify !== null ? (
        <p
          className={`text-2xs leading-relaxed ${verify.ok ? 'text-ink-muted' : 'text-signal'}`}
        >
          {verify.detail}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={pane.busy !== null || !ready} onClick={() => void submit()}>
          {pane.busy === 'save' ? 'Saving…' : existing === undefined ? 'Add and verify' : 'Save and verify'}
        </Button>
        {offersCertificate ? (
          <Button
            size="sm"
            variant="outline"
            className="text-2xs"
            disabled={pane.busy !== null}
            onClick={() => void fetchCertificate()}
          >
            {pane.busy === 'certificate' ? 'Fetching…' : "Fetch the server's certificate"}
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" className="text-2xs" onClick={onDone}>
          Done
        </Button>
      </div>

      {certificateProblem !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{certificateProblem}</p>
      ) : null}
      {certificate !== null ? (
        <CertificateOffer
          certificate={certificate}
          busy={pane.busy !== null}
          onTrust={() => {
            const pem = certificate.pem;
            setCertificate(null);
            void submit(pem);
          }}
          onDismiss={() => setCertificate(null)}
        />
      ) : null}
    </div>
  );
}

/** One declared field. Kept tiny so the generic form stays readable. */
export function FieldInput({
  field,
  value,
  onChange,
}: {
  readonly field: SecretField;
  readonly value: string;
  readonly onChange: (next: string) => void;
}): ReactElement {
  return (
    <div className="flex flex-col gap-1">
      <Input
        type={field.kind === 'secret' ? 'password' : 'text'}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={field.placeholder ?? field.label.toLowerCase()}
        autoComplete="off"
        spellCheck={false}
        className="w-80 text-xs md:text-xs"
        aria-label={field.label}
      />
      {field.note !== undefined ? (
        <p className="text-2xs leading-relaxed text-ink-faint">{field.note}</p>
      ) : null}
    </div>
  );
}
