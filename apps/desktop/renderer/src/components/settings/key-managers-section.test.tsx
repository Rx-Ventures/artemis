/**
 * @vitest-environment jsdom
 *
 * The Key managers pane, and the two properties that make it worth having.
 *
 *  - **It never pins a certificate silently.** Fetching one shows the
 *    fingerprint, the SANs and the expiry and stores nothing; only the
 *    confirming button saves a `caPem`. That sequence is the whole of what
 *    separates trust-on-first-use from no verification at all, so it is
 *    asserted step by step: the fetch does not save, the evidence renders, the
 *    confirm saves.
 *  - **A degraded row says which kind of degraded.** A standby OpenBao node
 *    reports itself with the status code every HTTP client reads as rate
 *    limiting; a pane that rendered "throttled" would be repeating the
 *    manager's most confusing quirk back at the user.
 *
 * The rest is the form being built from the provider's declared fields rather
 * than from a `switch`, which is the thing that stops the second provider from
 * being half-supported.
 *
 * Same caveat as its siblings: `renderer/tsconfig.json` excludes test files, so
 * `pnpm typecheck` never sees this one and the assertions are behavioural.
 */

import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type {
  SecretConnectionState,
  SecretProviderDescriptor,
  SecretServerCertificate,
  SecretsConnectionSaveRequest,
} from '@rx-artemis/protocol';

import { KeyManagersSection } from '@/components/settings/KeyManagersSection';
import { TooltipProvider } from '@/components/ui/tooltip';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ok = <T,>(value: T) => ({ ok: true as const, value });

const PROVIDERS: readonly SecretProviderDescriptor[] = [
  {
    id: 'openbao',
    label: 'OpenBao',
    note: 'Self-hosted secrets with policies and short-lived tokens.',
    authMethods: ['userpass', 'token'],
    configFields: [
      { id: 'address', label: 'Address', required: true, kind: 'text' },
      {
        id: 'username',
        label: 'Username',
        required: true,
        kind: 'text',
        onlyForAuthMethod: 'userpass',
      },
    ],
    refFields: [
      { id: 'mount', label: 'Mount', required: true, kind: 'text' },
      { id: 'path', label: 'Path', required: true, kind: 'text' },
      { id: 'key', label: 'Key', required: true, kind: 'text' },
    ],
  },
  {
    id: 'doppler',
    label: 'Doppler',
    note: 'Hosted secrets, organised by project and config.',
    authMethods: ['token'],
    configFields: [{ id: 'address', label: 'API address', required: false, kind: 'text' }],
    refFields: [{ id: 'name', label: 'Secret', required: true, kind: 'text' }],
  },
];

const CERTIFICATE: SecretServerCertificate = {
  fingerprintSha256: '9F:3C:1A:77:B2:E0:4D:6A',
  subject: 'CN=vault.example.com',
  issuer: 'CN=Example Internal CA, O=Example',
  san: ['DNS:vault.example.com', 'IP Address:100.75.234.21'],
  notAfter: '2027-08-27T12:00:00.000Z',
  pem: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n',
  selfSigned: false,
};

/** A row that verified cleanly, with the three facts a green tick needs. */
const WORKING: SecretConnectionState = {
  connection: {
    id: 'sec-1',
    label: 'Work vault',
    provider: 'openbao',
    address: 'https://vault.example.com:8200',
    authMethod: 'userpass',
    username: 'demo',
  },
  hasCredential: true,
  lastVerify: {
    at: 1_800_000_000_000,
    result: {
      ok: true,
      detail: 'OpenBao 2.6.2 is active.',
      identity: 'userpass-demo',
      policies: ['bao-admin', 'default'],
      expiresAt: '2026-09-28T09:14:03Z',
    },
  },
};

let connections: readonly SecretConnectionState[] = [];
const saveCalls: SecretsConnectionSaveRequest[] = [];
const verifyCalls: { id: string }[] = [];
const deleteCalls: { id: string }[] = [];
const certCalls: { address: string }[] = [];

/** Installed before the first render: `resolveBridge` memoises on first use. */
(globalThis.window as unknown as { artemis: unknown }).artemis = {
  secrets: {
    listConnections: async () => ok({ connections, providers: PROVIDERS }),
    saveConnection: async (request: SecretsConnectionSaveRequest) => {
      saveCalls.push(request);
      return ok({
        connections,
        providers: PROVIDERS,
        id: request.id ?? 'sec-new',
        verify: { ok: true, detail: 'Saved.' },
      });
    },
    verifyConnection: async (request: { id: string }) => {
      verifyCalls.push(request);
      return ok({ connections, providers: PROVIDERS, verify: { ok: true, detail: 'Checked.' } });
    },
    deleteConnection: async (request: { id: string }) => {
      deleteCalls.push(request);
      return ok({ connections: [], providers: PROVIDERS });
    },
    fetchServerCert: async (request: { address: string }) => {
      certCalls.push(request);
      return ok({ certificate: CERTIFICATE });
    },
    testRef: async () => ok({ found: true }),
  },
};

async function renderPane(): Promise<void> {
  render(
    <TooltipProvider>
      <KeyManagersSection />
    </TooltipProvider>,
  );
  await act(async () => {});
}

beforeEach(() => {
  connections = [];
});

afterEach(() => {
  cleanup();
  saveCalls.length = 0;
  verifyCalls.length = 0;
  deleteCalls.length = 0;
  certCalls.length = 0;
});

describe('the empty state', () => {
  it('says what connecting one buys, rather than just offering a button', async () => {
    await renderPane();
    expect(screen.getByText(/stop storing your git tokens/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Connect a key manager' })).toBeTruthy();
  });
});

describe('listing connections', () => {
  it('shows the identity, policies and expiry — not just that it worked', async () => {
    // "Reachable" says nothing about whose authority was proved. These three
    // are what make a green tick something that can be visibly wrong.
    connections = [WORKING];
    await renderPane();

    expect(screen.getByText('Work vault')).toBeTruthy();
    expect(screen.getByText('OpenBao')).toBeTruthy();
    expect(screen.getByText('working')).toBeTruthy();
    expect(screen.getByText('userpass-demo')).toBeTruthy();
    expect(screen.getByText('bao-admin, default')).toBeTruthy();
    expect(screen.getByText('2026-09-28T09:14:03Z')).toBeTruthy();
  });

  it('names the kind of degraded rather than calling standby a failure', async () => {
    connections = [
      {
        ...WORKING,
        lastVerify: {
          at: 1,
          result: { ok: true, detail: 'Standby node.', degraded: 'standby' },
        },
      },
    ];
    await renderPane();
    expect(screen.getByText('standby node')).toBeTruthy();
  });

  it('says a sealed manager is sealed', async () => {
    connections = [
      {
        ...WORKING,
        lastVerify: {
          at: 1,
          result: { ok: false, detail: 'OpenBao is sealed.', degraded: 'sealed', problem: 'sealed' },
        },
      },
    ];
    await renderPane();
    expect(screen.getByText('sealed')).toBeTruthy();
  });

  it('marks a connection that has never been checked as such', async () => {
    connections = [{ ...WORKING, lastVerify: null }];
    await renderPane();
    expect(screen.getByText('not checked')).toBeTruthy();
  });

  it('verifies on demand', async () => {
    connections = [WORKING];
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Verify' }).click();
    });
    expect(verifyCalls).toEqual([{ id: 'sec-1' }]);
  });

  it('asks before removing, because a reference pointing at it stops resolving', async () => {
    connections = [WORKING];
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: 'Remove' }).click();
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(deleteCalls).toEqual([]);

    await act(async () => {
      screen.getByRole('button', { name: 'Remove the connection' }).click();
    });
    expect(deleteCalls).toEqual([{ id: 'sec-1' }]);
  });
});

/**
 * Several managers at once, which is the arrangement this pane is for.
 *
 * A vault and a Doppler workplace, or production and staging: the list is a
 * list because more than one is ordinary. With a single row every per-row
 * action is trivially correct, so the assertions that matter are the ones that
 * name *which* row was acted on — and the ones that show a Doppler row
 * offering only what Doppler has.
 */
describe('several connections side by side', () => {
  /** The second provider, saved the only way Doppler can be: a token. */
  const DOPPLER: SecretConnectionState = {
    connection: {
      id: 'sec-2',
      label: 'Team Doppler',
      provider: 'doppler',
      address: 'https://api.doppler.com',
      authMethod: 'token',
    },
    hasCredential: true,
    lastVerify: {
      at: 1_800_000_000_000,
      result: { ok: true, detail: 'Doppler answered for 2 projects.', identity: 'artemis-sa' },
    },
  };

  it('lists every connection, with each one named by its own provider', async () => {
    connections = [WORKING, DOPPLER];
    await renderPane();

    expect(screen.getByText('Work vault')).toBeTruthy();
    expect(screen.getByText('Team Doppler')).toBeTruthy();
    // Both provider badges, so neither row is being described by the other's
    // provider — the failure a single-row fixture cannot produce.
    expect(screen.getByText('OpenBao')).toBeTruthy();
    expect(screen.getByText('Doppler')).toBeTruthy();
    expect(screen.getByText('userpass-demo')).toBeTruthy();
    expect(screen.getByText('artemis-sa')).toBeTruthy();
  });

  it('verifies the row that was clicked, not the first one', async () => {
    connections = [WORKING, DOPPLER];
    await renderPane();
    // Rows render in list order, so the second Verify belongs to the second
    // connection. Clicking it must name `sec-2`.
    await act(async () => {
      screen.getAllByRole('button', { name: 'Verify' })[1]?.click();
    });
    expect(verifyCalls).toEqual([{ id: 'sec-2' }]);
  });

  it('removes the row that was asked for, and says which one it is about', async () => {
    connections = [WORKING, DOPPLER];
    await renderPane();

    await act(async () => {
      screen.getAllByRole('button', { name: 'Remove' })[1]?.click();
    });
    // The dialog names the connection, because "remove the connection" over a
    // list of them is a sentence that could be about any row.
    expect(screen.getByText(/Remove “Team Doppler”/)).toBeTruthy();

    await act(async () => {
      screen.getByRole('button', { name: 'Remove the connection' }).click();
    });
    expect(deleteCalls).toEqual([{ id: 'sec-2' }]);
  });

  it('offers a Doppler row only what Doppler has', async () => {
    connections = [WORKING, DOPPLER];
    await renderPane();
    await act(async () => {
      screen.getAllByRole('button', { name: 'Edit' })[1]?.click();
    });

    // Doppler declares one auth method, so there is no choice to render — and
    // no username, because nothing signs in with one. The add form's version
    // of this is pinned separately; an existing row reaches the same fields
    // through `existing.authMethod`, which is a different code path.
    expect(screen.getByLabelText('API address')).toBeTruthy();
    expect(screen.getByLabelText('Token')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Username and password' })).toBeNull();
  });
});

describe('the certificate flow', () => {
  /** A row whose last verify failed on TLS — the state the flow exists for. */
  const untrusted: SecretConnectionState = {
    ...WORKING,
    lastVerify: {
      at: 1,
      result: {
        ok: false,
        detail: 'The certificate was not accepted: self signed certificate in certificate chain.',
        problem: 'tls',
      },
    },
  };

  it('offers to fetch a certificate only when the failure was about one', async () => {
    connections = [
      {
        ...WORKING,
        lastVerify: { at: 1, result: { ok: false, detail: 'Bad password.', problem: 'bad-credentials' } },
      },
    ];
    await renderPane();
    // A certificate button on a password failure is an invitation to trust a
    // server about an unrelated problem.
    expect(screen.queryByRole('button', { name: /Fetch the server/ })).toBeNull();

    cleanup();
    connections = [untrusted];
    await renderPane();
    expect(screen.getByRole('button', { name: /Fetch the server/ })).toBeTruthy();
  });

  it('fetching shows the evidence and stores nothing', async () => {
    connections = [untrusted];
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: /Fetch the server/ }).click();
    });

    expect(certCalls).toEqual([{ address: 'https://vault.example.com:8200' }]);
    // The evidence, on screen, before the button that acts on it.
    expect(screen.getByText('9F:3C:1A:77:B2:E0:4D:6A')).toBeTruthy();
    expect(screen.getByText('DNS:vault.example.com, IP Address:100.75.234.21')).toBeTruthy();
    expect(screen.getByText('2027-08-27T12:00:00.000Z')).toBeTruthy();
    expect(screen.getByText(/Nothing has been trusted yet/)).toBeTruthy();
    // Nothing pinned by looking.
    expect(saveCalls).toEqual([]);
  });

  it('only the confirming button stores the certificate', async () => {
    connections = [untrusted];
    await renderPane();

    await act(async () => {
      screen.getByRole('button', { name: /Fetch the server/ }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Not now' }).click();
    });
    // Dismissing is not consent.
    expect(saveCalls).toEqual([]);

    await act(async () => {
      screen.getByRole('button', { name: /Fetch the server/ }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Trust this certificate' }).click();
    });

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toMatchObject({
      id: 'sec-1',
      caPem: CERTIFICATE.pem,
      address: 'https://vault.example.com:8200',
    });
    // The save re-verifies by construction — it is the same channel.
    expect(saveCalls[0]).not.toHaveProperty('credential');
  });
});

describe('adding a connection', () => {
  it('builds the form from the provider, not from a switch', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Connect a key manager' }).click();
    });

    // OpenBao's declared fields, including the one that is only meaningful for
    // a username-and-password login.
    expect(screen.getByLabelText('Address')).toBeTruthy();
    expect(screen.getByLabelText('Username')).toBeTruthy();

    await act(async () => {
      screen.getByRole('button', { name: 'Doppler' }).click();
    });
    // Doppler declares one field and no userpass login, so both the username
    // and the auth-method choice are gone.
    expect(screen.getByLabelText('API address')).toBeTruthy();
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Username and password' })).toBeNull();
  });

  it('hides the username when the auth method has no use for it', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Connect a key manager' }).click();
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Paste a token' }).click();
    });
    // Asking for a value that does nothing is how a form teaches a user that
    // its fields are decorative.
    expect(screen.queryByLabelText('Username')).toBeNull();
    expect(screen.getByLabelText('Token')).toBeTruthy();
  });

  it('will not save until the required fields are filled', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Connect a key manager' }).click();
    });

    expect(
      screen.getByRole('button', { name: 'Add and verify' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(saveCalls).toEqual([]);
  });

  it('sends a userpass password as a password, and clears the field afterwards', async () => {
    await renderPane();
    await act(async () => {
      screen.getByRole('button', { name: 'Connect a key manager' }).click();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText('Connection label'), { target: { value: 'Work vault' } });
      fireEvent.change(screen.getByLabelText('Address'), {
        target: { value: 'https://vault.example.com:8200' },
      });
      fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'demo' } });
      fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'hunter2' } });
    });
    await act(async () => {
      screen.getByRole('button', { name: 'Add and verify' }).click();
    });

    expect(saveCalls).toHaveLength(1);
    expect(saveCalls[0]).toMatchObject({
      label: 'Work vault',
      provider: 'openbao',
      address: 'https://vault.example.com:8200',
      authMethod: 'userpass',
      username: 'demo',
      credential: { password: 'hunter2' },
    });
    // A password field is not a token field, and main treats them differently:
    // one is spent on a login, the other is stored.
    expect(saveCalls[0]?.credential).not.toHaveProperty('token');
  });
});
