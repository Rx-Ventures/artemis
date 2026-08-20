/**
 * @vitest-environment jsdom
 *
 * Capability degradation, asserted on the real feature components.
 *
 * `disabled-reason.test.tsx` covers the *mechanism* — that an explained
 * disabled control stays reachable and says why. This file covers the *policy*:
 * that the composer, the status line and the command palette are actually wired
 * to the capabilities they depend on, against the same store the app runs on.
 *
 * These exist because the failure they guard against is silent. A control gated
 * on a capability the provider lacks, but left enabled, does not throw and does
 * not look wrong — it accepts the click and the run quietly ignores it. That is
 * exactly the class of bug a screenshot cannot catch.
 *
 * ONE MORE REASON THIS FILE EARNS ITS KEEP: `renderer/tsconfig.json` excludes
 * `*.test.tsx`, so `pnpm typecheck` never sees these files and a stale import
 * here surfaces only when the suite runs. Keeping the assertions behavioural
 * rather than type-level is what makes that survivable.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NO_CAPABILITIES } from '@rx-artemis/protocol';
import type {
  Capabilities,
  ProviderDescriptor,
  ProviderEffortOption,
  ProviderModelOption,
  SessionSummary,
} from '@rx-artemis/protocol';

import { TooltipProvider } from '@/components/ui/tooltip';
import { CommandPalette } from '@/components/CommandPalette';
import { Composer } from '@/components/Composer';
import { StatusLine } from '@/components/StatusLine';
import { useApp } from '@/state/store';
import { appSession, seedApp } from '@/state/testkit';

/* Radix's floating layer needs observers jsdom does not implement. */
class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
/* cmdk scrolls its selected row into view on mount; jsdom has no such method. */
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

/**
 * Open a status-line segment's explanation and read it back.
 *
 * The reason on a disabled segment lives in a tooltip, which Radix mounts only
 * once the trigger is focused or hovered — the same mechanism
 * `disabled-reason.test.tsx` exercises. Asserting it this way rather than
 * looking for the text in the initial DOM is the point: it proves the
 * explanation is actually *reachable by keyboard*, which is the property that
 * makes an explained-disabled control better than a hidden one.
 */
async function explanationOf(label: string): Promise<string> {
  const segment = screen.getByLabelText(label);
  expect(segment.getAttribute('aria-disabled')).toBe('true');
  const wrapper = segment.closest('[data-slot="reason-wrapper"]') ?? segment;
  fireEvent.focus(wrapper);
  const bubbles = await screen.findAllByRole('tooltip');
  return bubbles.map((node) => node.textContent ?? '').join(' ');
}

const ALL: Capabilities = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  renameSession: true,
  deleteSession: true,
  permissionModes: ['default', 'plan'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

const MODELS: readonly ProviderModelOption[] = [
  { id: 'sonnet', label: 'Sonnet', note: 'Balanced.' },
  { id: 'opus', label: 'Opus', note: 'Most capable.' },
];

const EFFORTS: readonly ProviderEffortOption[] = [
  { id: 'low', label: 'Low', note: 'Fastest.' },
  { id: 'high', label: 'High', note: 'Deepest.' },
];

function descriptor(
  capabilities: Capabilities,
  extra?: Partial<ProviderDescriptor>,
): ProviderDescriptor {
  return {
    id: 'claude',
    label: 'Test Provider',
    capabilities,
    models: MODELS,
    effortLevels: EFFORTS,
    available: true,
    ...extra,
  };
}

const SESSION: SessionSummary = {
  id: 'sess-1111-2222',
  providerId: 'claude',
  profileId: 'p1',
  cwd: '/w',
  title: 'An earlier session',
  updatedAt: Date.now(),
};

/**
 * Point the store at a provider with the given capabilities.
 *
 * `run` is left null so `activeCapabilities` reads from the provider rather
 * than from a live run's frozen snapshot — except where a test needs a live
 * run, which it sets itself.
 */
function useProvider(capabilities: Capabilities, extra?: Partial<ProviderDescriptor>): void {
  seedApp({
    providers: [descriptor(capabilities, extra)],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/w',
    run: null,
    sessions: [SESSION],
    sessionsLoading: false,
    sessionsError: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
    model: null,
    effort: null,
    permissionMode: 'default',
    paletteOpen: false,
    infoOpen: false,
    promptHistory: [],
  });
}

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

beforeEach(() => useProvider(ALL));
afterEach(cleanup);

/* -------------------------------------------------------------------------- */
/* Composer                                                                   */
/* -------------------------------------------------------------------------- */

describe('composer / midRunSteering', () => {
  it('leaves the prompt usable mid-run when the provider can be steered', () => {
    useProvider(ALL);
    seedApp({
      run: {
        runId: 'r1',
        status: 'running',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/w',
        capabilities: ALL,
        startedAt: Date.now(),
      },
    });
    mount(<Composer />);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).disabled).toBe(false);
  });

  it('disables the prompt mid-run when it cannot, and says why', () => {
    const noSteering: Capabilities = { ...ALL, midRunSteering: false };
    useProvider(noSteering);
    seedApp({
      run: {
        runId: 'r1',
        status: 'running',
        providerId: 'claude',
        profileId: 'p1',
        cwd: '/w',
        capabilities: noSteering,
        startedAt: Date.now(),
      },
    });
    mount(<Composer />);
    const prompt = screen.getByLabelText('Prompt') as HTMLTextAreaElement;
    expect(prompt.disabled).toBe(true);
    // The explanation is not merely somewhere on the page — it names the
    // provider and the capability, which is the whole point of the affordance.
    expect(prompt.placeholder).toContain('Test Provider does not support sending messages mid-run');
  });

  it('does not disable the prompt before a run starts, whatever the capability', () => {
    useProvider({ ...ALL, midRunSteering: false });
    mount(<Composer />);
    expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).disabled).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Status line                                                                */
/* -------------------------------------------------------------------------- */

describe('status line / permission modes', () => {
  it('shows the current mode when the provider accepts it', () => {
    useProvider(ALL);
    mount(<StatusLine />);
    expect(screen.getByLabelText('Permission mode').textContent).toContain('ask');
  });

  it('warns when the stored mode is one this provider will not accept', () => {
    useProvider({ ...ALL, permissionModes: ['plan'] });
    seedApp({ permissionMode: 'bypassPermissions' });
    mount(<StatusLine />);
    expect(screen.getByLabelText('Permission mode').textContent).toContain('not accepted');
  });

  /**
   * The rule this pins down: a provider with no modes must not silently drop
   * the segment. The user has to be able to see that the concept exists and
   * learn that this provider does not have it.
   */
  it('renders the segment disabled with a reason when the provider has no modes', async () => {
    useProvider({ ...ALL, permissionModes: [] });
    mount(<StatusLine />);
    expect(await explanationOf('Permission mode')).toMatch(/does not expose permission modes/);
  });
});

describe('status line / model and effort', () => {
  it('builds the model segment from the descriptor rather than a literal', () => {
    useProvider(ALL);
    seedApp({ model: 'opus' });
    mount(<StatusLine />);
    expect(screen.getByLabelText('Model').textContent).toContain('Opus');
  });

  it('falls back to the provider default when the stored model is not offered', () => {
    useProvider(ALL, { models: [{ id: 'sonnet', label: 'Sonnet', note: 'Balanced.' }] });
    seedApp({ model: 'gpt-9' });
    mount(<StatusLine />);
    // A stored preference survives a provider switch, so naming something this
    // catalogue does not have is routine. It resolves to the catalogue's first
    // entry — the adapter contract's own default — rather than to an
    // "(unavailable)" placeholder naming a model that will not run. There is no
    // "provider default" row any more for the absent case to point at.
    expect(screen.getByLabelText('Model').textContent).toContain('Sonnet');
  });

  it('disables the model segment with a reason when the provider offers none', async () => {
    useProvider(ALL, { models: [] });
    mount(<StatusLine />);
    expect(await explanationOf('Model')).toMatch(/does not offer a model choice/);
  });

  it('offers no thinking control at all when the provider exposes no levels', async () => {
    // Thinking is a row inside the model popover now, not a segment on the bar.
    // A provider with no effort scale has no ladder to show, so the row is
    // absent rather than present-and-dead — there is nothing on this surface
    // for a reason to attach to.
    useProvider(ALL, { effortLevels: [] });
    mount(<StatusLine />);
    const trigger = screen.getByLabelText('Model');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await screen.findByRole('menu');
    expect(screen.queryByText('Thinking')).toBeNull();
  });

  it('puts thinking inside the model popover when the provider does offer levels', async () => {
    useProvider(ALL);
    mount(<StatusLine />);
    const trigger = screen.getByLabelText('Model');
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await screen.findByRole('menu');
    expect(screen.getByText('Thinking')).toBeTruthy();
  });

  /*
   * REGRESSION. The effort ladder opened leftward, off the side of the window.
   *
   * jsdom computes no layout, so the *position* is not assertable here — but the
   * cause is structural and is. The submenu was rendered inside the model menu,
   * which animates with a transform: a transformed ancestor becomes the
   * containing block for `position: fixed`, so the submenu was both clipped by
   * that menu's `overflow-y-auto` and measured against its box rather than the
   * window. Radix concluded there was no room to the right and flipped it into
   * even less. Portaling it out of that ancestor is the fix, and "is it a
   * descendant of the parent menu" is exactly the thing that regressed.
   */
  it('opens the thinking ladder outside the menu that owns it', async () => {
    useProvider(ALL);
    mount(<StatusLine />);
    fireEvent.pointerDown(screen.getByLabelText('Model'), {
      button: 0,
      ctrlKey: false,
      pointerType: 'mouse',
    });

    const menu = await screen.findByRole('menu');
    const submenuTrigger = screen.getByText('Thinking').closest('[data-slot="dropdown-menu-sub-trigger"]');
    expect(submenuTrigger).toBeTruthy();
    fireEvent.pointerMove(submenuTrigger as Element, { pointerType: 'mouse' });

    const ladder = await waitFor(() => {
      const found = document.querySelector('[data-slot="dropdown-menu-sub-content"]');
      if (!found) throw new Error('the thinking ladder never opened');
      return found;
    });

    // The whole fix, stated as a fact about the tree: the ladder is on the page
    // and is *not* inside the menu it belongs to.
    expect(menu.contains(ladder)).toBe(false);
    expect(document.body.contains(ladder)).toBe(true);
  });
});

/**
 * REGRESSION. Every picker on this bar is a `DropdownMenuTrigger asChild`
 * wrapping a local component, and `asChild` merges the trigger's props — the
 * click handler among them — onto whatever that component renders. A component
 * that destructures the props it wants and drops the rest therefore renders a
 * button that looks perfect, styles correctly, takes focus, and does nothing.
 *
 * That is exactly what shipped for a while. It passed `tsc` (the props are
 * optional), and it passed every assertion above (they all read the *closed*
 * trigger). Only opening one catches it, so each picker gets opened here.
 */
describe('status line / the pickers actually open', () => {
  // Thinking is no longer a trigger on this bar — it is a submenu inside the
  // model popover, covered by the two tests above.
  const PICKERS = ['Profile', 'Model', 'Permission mode'] as const;

  it.each(PICKERS)('%s opens its menu on click', async (label) => {
    useProvider(ALL);
    mount(<StatusLine />);
    const trigger = screen.getByLabelText(label);

    // The prop that proves the trigger is wired at all: Radix writes it onto
    // whatever element the Slot cloned. A dropped spread means it is absent.
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('data-state')).toBe('closed');

    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    await waitFor(() => expect(trigger.getAttribute('data-state')).toBe('open'));
    expect(await screen.findByRole('menu')).toBeTruthy();
  });
});

describe('status line / usageReporting', () => {
  it('no longer carries a context readout — it moved into the usage popover', () => {
    // The context window sits beside the plan limits now: both answer "how
    // much room is left", and splitting them meant checking two controls.
    // The *explanation* guarantee moved with it — see the popover's
    // ContextWindowRow, which names the provider rather than showing a dash.
    useProvider({ ...ALL, usageReporting: false });
    mount(<StatusLine />);
    expect(screen.queryByLabelText('Context usage')).toBeNull();
    // The rings that replaced it are present and are the way in. Matched on a
    // prefix because the label now spells out every ring's reading — see
    // `plan-usage-rings.test.tsx`.
    expect(screen.queryByLabelText(/^Plan usage/)).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Command palette                                                            */
/* -------------------------------------------------------------------------- */

describe('command palette / listSessions', () => {
  it('offers the session list when the provider can enumerate history', () => {
    useProvider(ALL);
    seedApp({ paletteOpen: true });
    mount(<CommandPalette />);
    const item = screen.getByText('Resume a past session…').closest('[role="option"]');
    expect(item?.getAttribute('aria-disabled')).not.toBe('true');
  });

  it('keeps the entry and explains it when the provider cannot', () => {
    useProvider({ ...NO_CAPABILITIES, permissionModes: [] });
    seedApp({ paletteOpen: true });
    mount(<CommandPalette />);
    const item = screen.getByText('Resume a past session…').closest('[role="option"]');
    // Present, disabled, and explained — never quietly absent.
    expect(item).not.toBeNull();
    expect(item?.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getAllByText(/does not support listing past sessions/).length).toBeGreaterThan(0);
  });
});

describe('command palette / forkSession', () => {
  it('explains that forking is unsupported rather than hiding the command', () => {
    useProvider({ ...ALL, forkSession: false });
    seedApp({ paletteOpen: true, resumeSessionId: 'sess-1111-2222' });
    mount(<CommandPalette />);
    const item = screen
      .getByText('Fork the current session on the next prompt')
      .closest('[role="option"]');
    expect(item?.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/does not support forking a session/)).toBeTruthy();
  });

  it('distinguishes "cannot fork" from "nothing to fork yet"', () => {
    useProvider(ALL);
    seedApp({ paletteOpen: true, resumeSessionId: null });
    mount(<CommandPalette />);
    expect(screen.getByText(/no session to fork yet/)).toBeTruthy();
  });
});

describe('command palette / resumeSession', () => {
  /**
   * The regression this pins down: `submitPrompt` only honours
   * `resumeSessionId` when the provider advertises `resumeSession`. Leaving the
   * rows selectable without it meant picking a session appeared to work, set
   * the id, and was then dropped when the run started — a silent no-op, which
   * is the one outcome the capability rules forbid.
   */
  it('marks the session list view-only when sessions cannot be resumed', () => {
    useProvider({ ...ALL, resumeSession: false });
    seedApp({ paletteOpen: true });
    mount(<CommandPalette />);
    expect(screen.getByText('view only')).toBeTruthy();
  });
});
