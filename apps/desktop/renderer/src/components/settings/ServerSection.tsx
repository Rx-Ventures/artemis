/**
 * The Server pane — Artemis as something other programs can use.
 * ============================================================================
 *
 * Every other pane in this dialog configures what happens *inside* Artemis.
 * This one opens a door out of it: a local HTTP server that publishes the
 * user's accounts and the models on each, so an editor, a script or an agent
 * running elsewhere on the machine can route through them. See
 * `protocol/src/server.ts` for the shape of what is published.
 *
 * ---------------------------------------------------------------------------
 * THE PANE IS MOSTLY A CATALOGUE, AND THAT IS DELIBERATE
 * ---------------------------------------------------------------------------
 *
 * The controls — start, stop, port, token — take a quarter of the surface. The
 * rest is the table of what is being served, because that is the thing a person
 * cannot otherwise see and the thing they are about to hand to another program.
 * A pane that only had a switch would leave "what does this expose?" answerable
 * only by `curl`, and the honest answer involves accounts: which ones, whether
 * each is signed in, and what each model will accept.
 *
 * The rows come from main, off the same cache the HTTP surface reads — never
 * reassembled here. Two assemblies of one catalogue drift, and the copy on
 * screen would be the one nobody is serving.
 *
 * ---------------------------------------------------------------------------
 * CONNECTIONS ARE THE ACCESS MODEL, AND THEY LIVE HERE
 * ---------------------------------------------------------------------------
 *
 * There is no server-wide password. Each connection is one token bound, at the
 * moment it is created, to the place its turns may run — a folder the user
 * picked, a scratch directory, or nothing at all. Creating one is therefore a
 * single decision about *which program gets in and where it may work*, which is
 * why the picker sits inside the create form rather than beside it.
 *
 * Tokens start masked, because a settings pane open on a screen-share should
 * not put a working credential in shot, and reveal on demand because the user's
 * next action is pasting one into another program's configuration — a control
 * that could only copy makes "did I paste the right one?" unanswerable.
 *
 * None of them is an account credential: each authenticates this port and
 * nothing else, and revoking one is a click. That is the whole reason they can
 * be on screen at all.
 *
 * ---------------------------------------------------------------------------
 * OFF UNTIL SOMEONE SAYS OTHERWISE, AND SAYS IT OUT LOUD
 * ---------------------------------------------------------------------------
 *
 * The server ships stopped, does not autostart, and cannot be turned on by a
 * single click. Every path that would make it reachable — the Start button and
 * the autostart switch — goes through {@link ConfirmStart} first.
 *
 * A confirmation on every start, rather than an acknowledgement remembered once,
 * because of what is actually being decided. This is not a preference; it is
 * lending every program on the machine the ability to spend the user's accounts,
 * and the circumstances that make that reasonable — which machine, who else is
 * on it, what is installed since last time — are different each time it is
 * asked. A remembered "yes, I understand" would be answering this month's
 * question with last month's answer. The dialog is two clicks on a control most
 * people touch a handful of times.
 */

import { useState } from 'react';
import type { ReactElement } from 'react';
import { CheckIcon, MinusIcon } from 'lucide-react';

import type {
  ServerAllowance,
  ServerConnection,
  ServerProfile,
  ServerState,
  ServerWorkspace,
} from '@rx-artemis/protocol';
import { MIN_SERVER_PORT, MAX_SERVER_PORT } from '@rx-artemis/protocol';

import { useServerState, type ServerPane } from '../../hooks/useServerState';
import { call, resolveBridge } from '../../lib/bridge';
import { CodeBlock, CopyButton, Fold, Row, StatusDot, ToneBadge, type Tone } from '../primitives';
import { ChoiceList, SettingsGroup, SettingsPane } from './pane';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

export function ServerSection(): ReactElement {
  const pane = useServerState();
  const running = pane.state.phase === 'running';
  const settling = pane.state.phase === 'starting' || pane.state.phase === 'stopping';

  const stopButton = (
    <Button size="sm" variant="outline" disabled={pane.busy || settling} onClick={pane.stop}>
      {startButtonLabel(pane.state.phase)}
    </Button>
  );

  return (
    <SettingsPane
      title="Server"
      description="Publish your profiles and their models to other programs on this machine, over a local HTTP API."
      actions={
        running || settling ? (
          stopButton
        ) : (
          <ConfirmStart
            what="start"
            onConfirm={pane.start}
            trigger={
              <Button size="sm" disabled={pane.busy}>
                {startButtonLabel(pane.state.phase)}
              </Button>
            }
          />
        )
      }
    >
      <OffByDefaultNotice />
      <StatusGroup pane={pane} />
      <ConnectionsGroup pane={pane} />
      <EndpointsGroup state={pane.state} />
      <CatalogueGroup pane={pane} />
    </SettingsPane>
  );
}

/**
 * The standing warning, above everything.
 *
 * Not inside the confirmation dialog alone: the dialog is read once, in the
 * moment of clicking, by someone who has already decided. This sits over the
 * pane for whoever opens it later — including the person who finds the server
 * already running and wonders what it is.
 */
function OffByDefaultNotice(): ReactElement {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-amber/40 bg-amber/5 px-3 py-2.5">
      <span className="text-xs font-medium text-amber">Off by default, and it should stay off
        unless you need it</span>
      <p className="text-2xs leading-relaxed text-ink-muted">
        Running this lets other programs on this machine send work through your accounts — your
        plans, your limits, your bill. Only do this if you are sure it is something you should be
        doing.
      </p>
    </div>
  );
}

/**
 * The gate in front of anything that makes the server reachable.
 *
 * Wraps a trigger rather than replacing it so the two call sites — the Start
 * button and the autostart switch — keep their own affordances and share one
 * piece of wording. `onConfirm` fires only on the confirm action; dismissing,
 * pressing Escape or clicking Cancel leaves the server exactly as it was, which
 * is the state this dialog exists to defend.
 */
function ConfirmStart({
  what,
  trigger,
  onConfirm,
}: {
  /** Which decision is being confirmed — the two have different consequences. */
  readonly what: 'start' | 'autostart';
  readonly trigger: ReactElement;
  readonly onConfirm: () => void;
}): ReactElement {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {what === 'start' ? 'Start the server?' : 'Start the server at every launch?'}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="flex flex-col gap-2 text-2xs leading-relaxed">
              <p>
                Only do this if you are sure it is something you should be doing. Any program on
                this machine that has the token can list your accounts and — as this grows — send
                work through them, spending your plans and your limits.
              </p>
              <p>
                The port is loopback-only and every request needs the token, so nothing off this
                machine can reach it and nothing on it can reach it by accident. What it cannot
                protect against is a program you gave the token to.
              </p>
              {what === 'autostart' ? (
                <p>
                  Turning this on means the port is bound every time Artemis launches, including
                  the launches where you had not thought about it.
                </p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            {what === 'start' ? 'Start the server' : 'Start it at launch'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function startButtonLabel(phase: ServerState['phase']): string {
  switch (phase) {
    case 'running':
      return 'Stop';
    case 'starting':
      return 'Starting…';
    case 'stopping':
      return 'Stopping…';
    default:
      return 'Start';
  }
}

/* -------------------------------------------------------------------------- */
/* Status                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where the server is, and where to point a client.
 *
 * The URL is the one thing on this pane a user copies most, so it is the
 * biggest text in the group and carries its own copy button rather than living
 * in a `Row` beside four other facts.
 */
function StatusGroup({ pane }: { readonly pane: ServerPane }): ReactElement {
  const { state } = pane;
  const running = state.phase === 'running';

  return (
    <SettingsGroup label="Status">
      <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
        <div className="flex items-center gap-2">
          <StatusDot tone={phaseTone(state.phase)} pulse={state.phase === 'running'} />
          <span className="text-xs font-medium text-ink">{phaseLabel(state.phase)}</span>
          {running && state.url !== undefined ? (
            <span className="group/copy ml-auto flex items-center gap-1.5">
              <code className="font-mono text-xs text-ink-muted">{state.url}</code>
              <CopyButton text={state.url} label="Copy the server address" className="relative" />
            </span>
          ) : null}
        </div>

        {state.lastError !== undefined ? (
          <p className="text-2xs leading-relaxed text-signal">{state.lastError.message}</p>
        ) : null}

        {running ? (
          <div className="flex flex-col">
            <Row label="Requests answered">{state.traffic.total}</Row>
            {/*
              Refusals are shown only once there are some. A permanent "0
              rejected" reads as a metric to watch; a number that appears the
              first time something knocks without the token is news.
            */}
            {state.traffic.rejected > 0 ? (
              <Row label="Refused — wrong or missing token">
                <span className="text-amber">{state.traffic.rejected}</span>
              </Row>
            ) : null}
            <Row label="Listening since">
              {state.startedAt === undefined ? '—' : new Date(state.startedAt).toLocaleTimeString()}
            </Row>
          </div>
        ) : (
          <p className="text-2xs leading-relaxed text-ink-faint">
            Nothing is listening. Starting the server binds{' '}
            <span className="font-mono">
              {state.host}:{state.port === 0 ? 'a free port' : state.port}
            </span>{' '}
            — loopback only, so nothing off this machine can reach it.
          </p>
        )}
      </div>

      <PortRow pane={pane} />

      <AutoStartRow pane={pane} />
    </SettingsGroup>
  );
}

/**
 * Autostart, asymmetric on purpose.
 *
 * Turning it *on* goes through the same confirmation the Start button does —
 * it is the more consequential of the two, because it binds the port on every
 * future launch including the ones nobody is thinking about. Turning it *off*
 * is immediate: nothing that reduces exposure should ever need permission.
 *
 * The switch is rendered outside a `<label>` when it is off, because a label
 * wrapping an `AlertDialogTrigger` would toggle the switch on the way to
 * opening the dialog — the state would flip before the question was answered.
 */
function AutoStartRow({ pane }: { readonly pane: ServerPane }): ReactElement {
  const copy = (
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-xs leading-snug font-medium text-ink">Start with Artemis</span>
      <span className="text-2xs leading-relaxed text-ink-faint">
        Bind the port at launch, so a program configured against it works without opening this
        window first.
      </span>
    </span>
  );

  if (pane.state.autoStart) {
    return (
      <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-line bg-panel px-3 py-2">
        <Switch
          checked
          onCheckedChange={() => pane.configure({ autoStart: false })}
          className="mt-[3px]"
        />
        {copy}
      </label>
    );
  }

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-line bg-panel px-3 py-2">
      <ConfirmStart
        what="autostart"
        onConfirm={() => pane.configure({ autoStart: true })}
        trigger={
          <Switch
            checked={false}
            aria-label="Start with Artemis"
            className="mt-[3px] cursor-pointer"
          />
        }
      />
      {copy}
    </div>
  );
}

/**
 * The port, committed on blur or Enter rather than per keystroke.
 *
 * Typing "8080" passes through "8", "80" and "808", and a field that saved each
 * of those would rebind a running server three times on the way to the number
 * the user meant — twice to ports they never asked for.
 */
function PortRow({ pane }: { readonly pane: ServerPane }): ReactElement {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(pane.state.port);

  const commit = (): void => {
    setDraft(null);
    if (draft === null) return;
    const parsed = Number.parseInt(draft, 10);
    // An unparseable or out-of-range entry reverts rather than errors: the
    // field is one number with an obvious previous value, and a validation
    // message under it would be more chrome than the mistake is worth.
    if (!Number.isInteger(parsed)) return;
    if (parsed !== 0 && (parsed < MIN_SERVER_PORT || parsed > MAX_SERVER_PORT)) return;
    if (parsed === pane.state.port) return;
    pane.configure({ port: parsed });
  };

  return (
    <div className="flex items-center gap-3 rounded-lg border border-line bg-panel px-3 py-2">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-xs leading-snug font-medium text-ink">Port</span>
        <span className="text-2xs leading-relaxed text-ink-faint">
          Changing this while the server is running rebinds it. Use <span className="font-mono">0</span>{' '}
          to let the system pick a free one.
        </span>
      </span>
      <Input
        value={shown}
        inputMode="numeric"
        aria-label="Server port"
        className="w-24 shrink-0 font-mono text-xs"
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
          if (event.key === 'Escape') setDraft(null);
        }}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Connections                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The connections, which are the whole access model.
 *
 * There is no server-wide password. A connection *is* a token, and creating one
 * is the moment a person decides two things at once: which program gets in, and
 * where its turns are allowed to run. That pairing is why this pane has a
 * folder picker in it rather than a "generate token" button — the grant and the
 * credential are one decision, and splitting them into two controls would let
 * someone issue a token now and think about the directory later, which is
 * exactly the order that goes wrong.
 */
function ConnectionsGroup({ pane }: { readonly pane: ServerPane }): ReactElement {
  const { connections } = pane.state;

  return (
    <SettingsGroup label="Connections">
      <p className="text-2xs leading-relaxed text-ink-muted">
        Each connection is one token, bound when you create it to the place its turns run. Send it
        as <span className="font-mono">Authorization: Bearer …</span>, or as{' '}
        <span className="font-mono">x-api-key</span> where a client expects that. A connection
        authenticates this port only — it is not one of your provider credentials, and deleting one
        revokes exactly that program.
      </p>

      {connections.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          No connections, so nothing can reach this server even while it is running. Create one to
          let a program in.
        </p>
      ) : (
        connections.map((connection) => (
          <ConnectionRow key={connection.id} connection={connection} pane={pane} />
        ))
      )}

      <NewConnection pane={pane} />
    </SettingsGroup>
  );
}

function ConnectionRow({
  connection,
  pane,
}: {
  readonly connection: ServerConnection;
  readonly pane: ServerPane;
}): ReactElement {
  const [revealed, setRevealed] = useState(false);
  /*
   * The label edits in place, committed on blur or Enter.
   *
   * In place rather than behind a dialog because it is the *only* editable
   * field — the workspace and the accounts are fixed at creation — so a form
   * would be a modal containing one text box, and a form that could only change
   * the name would imply the rest were negotiable too.
   */
  const [draft, setDraft] = useState<string | null>(null);

  const commit = (): void => {
    const next = draft?.trim();
    setDraft(null);
    if (next === undefined || next.length === 0 || next === connection.label) return;
    pane.renameConnection(connection.id, next);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {draft === null ? (
          <button
            type="button"
            className="rounded-sm text-xs font-medium text-ink hover:text-beam focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
            title="Rename"
            onClick={() => setDraft(connection.label)}
          >
            {connection.label}
          </button>
        ) : (
          <Input
            value={draft}
            autoFocus
            aria-label={`Rename ${connection.label}`}
            className="h-6 w-40 text-xs"
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
              if (event.key === 'Escape') setDraft(null);
            }}
          />
        )}
        <WorkspaceBadge workspace={connection.workspace} />
        {connection.allow !== undefined && connection.allow.length > 0 ? (
          <ToneBadge tone="amber">{summariseAllowance(connection.allow)}</ToneBadge>
        ) : null}
        <span className="ml-auto text-2xs text-ink-faint">
          {connection.lastUsedAt === undefined
            ? 'never used'
            : `last used ${new Date(connection.lastUsedAt).toLocaleTimeString()}`}
        </span>
      </div>

      <div className="group/copy flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-muted">
          {revealed ? connection.token : maskToken(connection.token)}
        </code>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          onClick={() => setRevealed((current) => !current)}
        >
          {revealed ? 'Hide' : 'Reveal'}
        </Button>
        <CopyButton
          text={connection.token}
          label={`Copy the token for ${connection.label}`}
          className="relative shrink-0"
        />
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 text-signal hover:text-signal"
          disabled={pane.busy}
          onClick={() => pane.deleteConnection(connection.id)}
        >
          Revoke
        </Button>
      </div>
    </div>
  );
}

/**
 * Which accounts and models a new connection may reach.
 *
 * ---------------------------------------------------------------------------
 * NOTHING TICKED MEANS EVERYTHING
 * ---------------------------------------------------------------------------
 *
 * The inversion is deliberate and is stated on screen, because the alternative
 * is worse. If an empty list meant "nothing", then every user who skipped this
 * section — which is the common case, and the one where they have not thought
 * about it — would get a token that authenticates fine and can reach no model,
 * failing at the first request with a 404 for a route they can see in the app.
 *
 * So an untouched list is an unrestricted token, and narrowing is an act. That
 * matches how the allowance is stored (`allow` absent means everything) and how
 * the server reads it, so there is one rule rather than a UI convention layered
 * over a different wire convention.
 *
 * ---------------------------------------------------------------------------
 * A WHOLE ACCOUNT IS NOT THE SAME AS ALL OF ITS MODELS
 * ---------------------------------------------------------------------------
 *
 * Ticking an account row stores an entry with *no model list*, which follows
 * that account as the provider ships models. Ticking every model individually
 * would freeze the grant at today's catalogue. `create` collapses the second
 * into the first when every box happens to be ticked, so the user cannot
 * accidentally choose the frozen version by clicking each row.
 */
function AllowList({
  catalogue,
  allowed,
  onToggleProfile,
  onToggleModel,
}: {
  readonly catalogue: readonly ServerProfile[] | null;
  readonly allowed: ReadonlyMap<string, ReadonlySet<string>>;
  readonly onToggleProfile: (profileId: string, modelIds: readonly string[]) => void;
  readonly onToggleModel: (profileId: string, modelId: string) => void;
}): ReactElement {
  const restricted = allowed.size > 0;

  if (catalogue === null) {
    return (
      <p className="text-2xs leading-relaxed text-ink-faint">Reading the catalogue…</p>
    );
  }

  if (catalogue.length === 0) {
    return (
      <p className="text-2xs leading-relaxed text-ink-faint">
        No accounts yet, so there is nothing to restrict this connection to.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <span className="chrome-label text-ink-faint">What it may use</span>
      <p className="text-2xs leading-relaxed text-ink-faint">
        {restricted
          ? 'Only the ticked routes. Anything else is invisible to this token — it cannot run them, and cannot see that they exist.'
          : 'Nothing ticked, so this connection may use every account and model. Tick to narrow it.'}
      </p>

      <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-line bg-panel px-2.5 py-2">
        {catalogue.map((profile) => {
          const models = allowed.get(profile.id);
          const whole = models !== undefined && profile.models.every((m) => models.has(m.id));
          return (
            <div key={profile.id} className="flex flex-col gap-0.5">
              <label className="flex cursor-pointer items-center gap-2 text-2xs">
                <Checkbox
                  checked={whole}
                  aria-label={`Allow every model on ${profile.label}`}
                  onCheckedChange={() =>
                    onToggleProfile(
                      profile.id,
                      profile.models.map((model) => model.id),
                    )
                  }
                />
                <span className="font-medium text-ink">{profile.label}</span>
                <span className="text-ink-faint">{profile.provider.label}</span>
              </label>

              <div className="flex flex-col gap-0.5 pl-6">
                {profile.models.map((model) => (
                  <label
                    key={model.route}
                    className="flex cursor-pointer items-center gap-2 text-2xs"
                  >
                    <Checkbox
                      checked={models?.has(model.id) ?? false}
                      aria-label={`Allow ${model.route}`}
                      onCheckedChange={() => onToggleModel(profile.id, model.id)}
                    />
                    <code className="font-mono text-ink-muted">{model.route}</code>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What a connection may reach, in one chip.
 *
 * Three visually distinct states rather than a path or a blank, because the
 * difference between them is the difference between "can edit my repository",
 * "can scribble somewhere disposable" and "cannot run anything" — and a row
 * that showed an empty cell for the last two would make them look like the same
 * unfinished thing.
 */
function WorkspaceBadge({ workspace }: { readonly workspace: ServerWorkspace }): ReactElement {
  switch (workspace.kind) {
    case 'directory':
      return (
        <code className="truncate font-mono text-2xs text-ink-faint" title={workspace.path}>
          {workspace.path}
        </code>
      );
    case 'ephemeral':
      return <ToneBadge tone="cyan">scratch space</ToneBadge>;
    case 'none':
      return <ToneBadge tone="neutral">catalogue only</ToneBadge>;
  }
}

/**
 * Creating one: a name, and the choice that cannot be changed afterwards.
 *
 * The three workspace options are offered as a `ChoiceList` rather than a
 * dropdown for the reason that component exists — each one needs a sentence
 * saying what it costs, and "ephemeral" means nothing without one.
 */
function NewConnection({ pane }: { readonly pane: ServerPane }): ReactElement {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ServerWorkspace['kind']>('ephemeral');
  const [path, setPath] = useState<string | null>(null);
  /*
   * The chosen routes, as `profileId` → the model ids ticked on it.
   *
   * Empty map means "everything", which is both the default and the thing an
   * empty *allowance* means on the wire — so a user who never opens this
   * section gets an unrestricted token, and one who opens it and unticks
   * everything is stopped from creating a token that can reach nothing.
   */
  const [allowed, setAllowed] = useState<ReadonlyMap<string, ReadonlySet<string>>>(new Map());

  const reset = (): void => {
    setOpen(false);
    setLabel('');
    setKind('ephemeral');
    setPath(null);
    setAllowed(new Map());
  };

  const toggleModel = (profileId: string, modelId: string): void => {
    setAllowed((current) => {
      const next = new Map(current.entries());
      const models = new Set(next.get(profileId) ?? []);
      if (models.has(modelId)) models.delete(modelId);
      else models.add(modelId);
      if (models.size === 0) next.delete(profileId);
      else next.set(profileId, models);
      return next;
    });
  };

  const toggleProfile = (profileId: string, modelIds: readonly string[]): void => {
    setAllowed((current) => {
      const next = new Map(current.entries());
      // All-or-nothing on the account row: ticking it means every model it has
      // now, which is also what an entry with no model list means on the wire.
      if (next.has(profileId)) next.delete(profileId);
      else next.set(profileId, new Set(modelIds));
      return next;
    });
  };

  const pickFolder = async (): Promise<void> => {
    const bridge = resolveBridge().bridge;
    if (!bridge) return;
    const result = await call(() => bridge.workspace.pickDirectory({}));
    if (result.ok && result.value.path !== null) {
      setPath(result.value.path);
      setKind('directory');
    }
  };

  const create = (): void => {
    const workspace: ServerWorkspace =
      kind === 'directory'
        ? // Guarded by `ready` below, so this branch cannot be reached without a
          // path — a connection created with `kind: 'directory'` and no folder
          // would be a grant to nowhere.
          { kind: 'directory', path: path ?? '' }
        : kind === 'ephemeral'
          ? { kind: 'ephemeral', perSession: true }
          : { kind: 'none' };

    /*
     * An account whose every model is ticked is sent with no model list.
     *
     * Not a micro-optimisation — the two mean different things over time. A list
     * naming today's models freezes the grant, so a model the provider ships
     * next month would be invisible to this token; an entry with no list follows
     * the account. Ticking everything reads as "this whole account", so that is
     * what gets stored.
     */
    const allow: ServerAllowance[] = [...allowed.entries()].map(([profileId, models]) => {
      const profile = (pane.catalogue ?? []).find((entry) => entry.id === profileId);
      const every =
        profile !== undefined &&
        profile.models.length > 0 &&
        profile.models.every((model) => models.has(model.id));
      return every
        ? { profileId: profileId as ServerAllowance['profileId'] }
        : { profileId: profileId as ServerAllowance['profileId'], modelIds: [...models] };
    });

    pane.createConnection({
      label: label.trim() || 'Connection',
      workspace,
      ...(allow.length === 0 ? {} : { allow }),
    });
    reset();
  };

  const ready = kind !== 'directory' || (path !== null && path.length > 0);

  if (!open) {
    return (
      <Button size="sm" variant="outline" className="self-start" onClick={() => setOpen(true)}>
        New connection
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-beam/30 bg-beam/5 px-3 py-2.5">
      <Input
        value={label}
        autoFocus
        placeholder="What is this for? e.g. Kronos, summariser"
        aria-label="Connection name"
        className="text-xs"
        onChange={(event) => setLabel(event.target.value)}
      />

      <ChoiceList
        label="Where this connection's turns run"
        value={kind}
        onChange={(next) => setKind(next)}
        choices={[
          {
            id: 'ephemeral',
            label: 'Scratch space',
            note: 'A temporary directory, deleted afterwards. The agent can still write files and run commands — nothing it leaves behind is kept, and none of it lands in your projects.',
          },
          {
            id: 'directory',
            label: path ?? 'A folder you choose…',
            note: 'Turns run here, and the agent can read and write in it. Pick the folder before creating the connection — it cannot be changed afterwards.',
          },
          {
            id: 'none',
            label: 'Catalogue only',
            note: 'Can list your accounts and models but cannot run a turn at all. The right grant for a picker or a dashboard.',
          },
        ]}
      />

      {kind === 'directory' ? (
        <Button size="sm" variant="outline" className="self-start" onClick={() => void pickFolder()}>
          {path === null ? 'Choose folder…' : 'Choose a different folder…'}
        </Button>
      ) : null}

      <AllowList
        catalogue={pane.catalogue}
        allowed={allowed}
        onToggleProfile={toggleProfile}
        onToggleModel={toggleModel}
      />

      <p className="text-2xs leading-relaxed text-ink-faint">
        This choice is fixed when the token is created. To move a connection somewhere else, make a
        new one and revoke this — a token whose reach can widen later is one nobody can reason
        about.
      </p>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={pane.busy || !ready} onClick={create}>
          Create connection
        </Button>
        <Button size="sm" variant="ghost" onClick={reset}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** Show the shape and the tail: enough to tell two tokens apart, not enough to use one. */
function maskToken(token: string): string {
  return `${'•'.repeat(Math.min(24, Math.max(0, token.length - 6)))}${token.slice(-6)}`;
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What to point a client at, with a command that works.
 *
 * The `curl` line carries the real token and the real port, because the version
 * with placeholders is the version that gets pasted with the placeholders still
 * in it. It is folded shut: it is reference material, and the token inside it
 * should not be on screen by default for the reason the token block masks
 * itself.
 */
function EndpointsGroup({ state }: { readonly state: ServerState }): ReactElement {
  const base = state.url ?? `http://${state.host}:${state.port === 0 ? '<port>' : state.port}`;
  // The first connection's token, so the line is runnable as printed. With none
  // configured it stays a placeholder rather than inventing one — there is no
  // server-wide credential to fall back to, which is the point of the model.
  const token = state.connections[0]?.token ?? '<token>';

  return (
    <SettingsGroup label="Endpoints">
      <div className="flex flex-col gap-1 rounded-lg border border-line bg-panel px-3 py-2.5">
        <EndpointRow path="/v1/models" note="Every route, in the shape OpenAI clients expect." />
        <EndpointRow
          path="/api/v0/profiles"
          note="Accounts, their capabilities, and the models on each."
        />
        <EndpointRow
          path="/api/v0/models"
          note="Every route with its thinking levels, fast mode and ultracode."
        />
        <EndpointRow path="/health" note="Liveness. The only path that needs no token." />
      </div>

      <Fold
        summary={<span className="text-2xs text-ink-muted">Try it from a terminal</span>}
        rememberAs="server-curl"
      >
        <CodeBlock text={`curl -s ${base}/v1/models \\\n  -H "Authorization: Bearer ${token}"`} />
      </Fold>
    </SettingsGroup>
  );
}

function EndpointRow({
  path,
  note,
}: {
  readonly path: string;
  readonly note: string;
}): ReactElement {
  return (
    <div className="flex items-baseline gap-3 py-[3px]">
      <code className="shrink-0 font-mono text-2xs text-ink-muted">{path}</code>
      <span className="min-w-0 flex-1 text-right text-2xs text-ink-faint">{note}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Catalogue                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What is published: one card per account, one row per route.
 *
 * The account is the unit rather than the model, because the account is what a
 * route actually spends — two profiles offering the same model are two
 * different bills, on two different plans, and a flat list of model names would
 * hide exactly that.
 */
function CatalogueGroup({ pane }: { readonly pane: ServerPane }): ReactElement {
  const profiles = pane.catalogue;
  const routes = (profiles ?? []).reduce((total, profile) => total + profile.models.length, 0);

  return (
    <SettingsGroup label="What this publishes">
      <div className="flex items-center gap-2">
        <p className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-muted">
          {profiles === null
            ? 'Reading the catalogue…'
            : profiles.length === 0
              ? 'No profiles yet, so there is nothing to route to. Add one in Profiles.'
              : `${routes} route${routes === 1 ? '' : 's'} across ${profiles.length} account${
                  profiles.length === 1 ? '' : 's'
                }. A client addresses one as ${'`profile/model`'}.`}
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0"
          disabled={pane.loadingCatalogue}
          onClick={() => pane.reloadCatalogue({ refresh: true })}
        >
          {pane.loadingCatalogue ? 'Reading…' : 'Refresh'}
        </Button>
      </div>

      {pane.catalogueError !== null ? (
        <p className="text-2xs leading-relaxed text-signal">{pane.catalogueError}</p>
      ) : null}

      {(profiles ?? []).map((profile) => (
        <ProfileCard key={profile.id} profile={profile} />
      ))}
    </SettingsGroup>
  );
}

function ProfileCard({ profile }: { readonly profile: ServerProfile }): ReactElement {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-panel px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-ink">{profile.label}</span>
        <code className="font-mono text-2xs text-ink-faint">{profile.slug}/…</code>
        <span className="ml-auto flex items-center gap-1.5">
          <ToneBadge tone="neutral">{profile.provider.label}</ToneBadge>
          {/*
            Three states worth distinguishing, and each says something different
            about whether a client can rely on the rows below. Unavailable: the
            provider is not usable here at all. Not live: these are the built-in
            model names, which the account never confirmed. Hidden: the user took
            this account out of Artemis's own picker — it stays routable, because
            hiding a profile from a menu is not the same as revoking it from a
            program that was configured against it, and a row that silently
            disappeared would be the harder failure to diagnose.
          */}
          {!profile.available ? <ToneBadge tone="signal">unavailable</ToneBadge> : null}
          {profile.available && !profile.live ? (
            <ToneBadge tone="amber">unconfirmed</ToneBadge>
          ) : null}
          {profile.disabled ? <ToneBadge tone="neutral">hidden in Artemis</ToneBadge> : null}
        </span>
      </div>

      {profile.unavailableReason !== undefined ? (
        <p className="text-2xs leading-relaxed text-ink-faint">{profile.unavailableReason}</p>
      ) : null}

      {profile.models.length === 0 ? (
        <p className="text-2xs leading-relaxed text-ink-faint">
          This account offers no model choice, so it publishes no routes.
        </p>
      ) : (
        <div className="flex flex-col divide-y divide-line/60">
          {profile.models.map((model) => (
            <div key={model.route} className="flex flex-col gap-1 py-1.5 first:pt-0 last:pb-0">
              <div className="group/copy flex items-baseline gap-2">
                <code className="min-w-0 flex-1 truncate font-mono text-2xs text-ink">
                  {model.route}
                </code>
                <span className="shrink-0 text-2xs text-ink-faint">
                  {model.displayName ?? model.label}
                </span>
                <CopyButton text={model.route} label="Copy this route" className="relative shrink-0" />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {/*
                  Thinking levels are listed rather than counted: "high" is the
                  string a caller sends, and a badge reading "3 levels" would
                  leave them looking it up somewhere else.
                */}
                {model.thinkingLevels.length === 0 ? (
                  <Capability on={false} label="no thinking levels" />
                ) : (
                  model.thinkingLevels.map((level) => (
                    <code
                      key={level.id}
                      title={level.note}
                      className="rounded-sm border border-line bg-raised px-1.5 py-[1px] font-mono text-[10px] text-ink-muted"
                    >
                      {level.id}
                    </code>
                  ))
                )}
                {model.adaptiveThinking ? (
                  <span
                    className="text-[10px] text-ink-faint"
                    title="This model decides its own depth, so a level is a hint rather than an instruction."
                  >
                    adaptive
                  </span>
                ) : null}
                <span className="ml-auto flex items-center gap-2">
                  <Capability on={model.fastMode} label="fast mode" />
                  <Capability on={model.ultracode} label="ultracode" />
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One accepted-or-not flag.
 *
 * Both states are drawn, and that is the point of the component. "Fast mode is
 * not offered here" is the fact a caller needs — a setting a run silently
 * ignores is worse than one it refuses — and an absent badge would be
 * indistinguishable from a catalogue that had not loaded.
 */
function Capability({ on, label }: { readonly on: boolean; readonly label: string }): ReactElement {
  return (
    <span
      className={cn(
        'flex items-center gap-1 text-[10px]',
        on ? 'text-mint' : 'text-ink-faint line-through decoration-ink-faint/40',
      )}
    >
      {on ? (
        <CheckIcon aria-hidden="true" className="size-2.5" />
      ) : (
        <MinusIcon aria-hidden="true" className="size-2.5" />
      )}
      {label}
    </span>
  );
}

/**
 * "2 accounts" or "3 models" — whichever the grant actually is.
 *
 * Two shapes rather than one number, because they answer different questions. A
 * connection given whole accounts is scoped by *who pays*; one given specific
 * models is scoped by *what runs*. Reporting both as "2 entries" would hide the
 * distinction the user made when they created it.
 */
function summariseAllowance(allow: readonly ServerAllowance[]): string {
  const models = allow.reduce((total, entry) => total + (entry.modelIds?.length ?? 0), 0);
  if (models === 0) return `${allow.length} account${allow.length === 1 ? '' : 's'}`;
  const whole = allow.filter((entry) => entry.modelIds === undefined).length;
  const parts = [`${models} model${models === 1 ? '' : 's'}`];
  if (whole > 0) parts.push(`${whole} account${whole === 1 ? '' : 's'}`);
  return parts.join(' + ');
}

function phaseLabel(phase: ServerState['phase']): string {
  switch (phase) {
    case 'running':
      return 'Running';
    case 'starting':
      return 'Starting';
    case 'stopping':
      return 'Stopping';
    case 'error':
      return 'Could not start';
    default:
      return 'Stopped';
  }
}

function phaseTone(phase: ServerState['phase']): Tone {
  switch (phase) {
    case 'running':
      return 'mint';
    case 'starting':
    case 'stopping':
      return 'amber';
    case 'error':
      return 'signal';
    default:
      return 'neutral';
  }
}
