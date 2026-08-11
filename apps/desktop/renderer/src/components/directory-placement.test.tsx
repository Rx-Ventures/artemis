/**
 * @vitest-environment jsdom
 *
 * Where the working directory is offered, and where it is not.
 *
 * The directory belongs to the session in the working column, so it is stated
 * and set in the status line — the bar whose subject is what the next prompt
 * will do. The sidebar used to carry a second control for it, one row under New
 * session, which framed it as a standing property of the window that the next
 * session would inherit. That framing is the thing being tested against.
 *
 * This is a placement assertion, which is unusual enough to justify. It is here
 * because the regression is silent in exactly the way `capability-gating`
 * describes: putting a directory control back in the sidebar breaks nothing,
 * throws nothing and looks entirely reasonable in review. Only the scope is
 * wrong, and scope is not visible in a diff of two files.
 *
 * As with the other test files, `renderer/tsconfig.json` excludes these, so
 * `pnpm typecheck` never sees them and the assertions stay behavioural.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Sidebar } from '@/components/Sidebar';
import { StatusLine } from '@/components/StatusLine';
import { useApp } from '@/state/store';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const CAPABILITIES = {
  interactivePermissions: true,
  partialMessages: true,
  midRunSteering: true,
  forkSession: true,
  listSessions: true,
  subagents: true,
  permissionModes: ['default', 'plan'],
  resumeSession: true,
  usageReporting: true,
  costReporting: true,
  planUsageReporting: true,
};

beforeEach(() => {
  useApp.setState({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities: CAPABILITIES,
        models: [{ id: 'sonnet', label: 'Sonnet' }],
        effortLevels: [],
        available: true,
      },
    ],
    activeProviderId: 'claude',
    profiles: [{ id: 'p1', label: 'P', providerId: 'claude', configDir: '/Users/me/.claude' }],
    activeProfileId: 'p1',
    cwd: '/w',
    run: null,
    sessions: [],
    sessionsLoading: false,
    sessionsError: null,
    resumeSessionId: null,
    permissionQueue: [],
    banners: [],
    sidebarCollapsed: false,
    model: null,
    effort: null,
    permissionMode: 'default',
    paletteOpen: false,
    infoOpen: false,
    promptHistory: [],
  });
});

afterEach(cleanup);

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

describe('the working directory', () => {
  it('is not offered in the sidebar', () => {
    mount(<Sidebar />);

    // The removed control's own label, and the path it rendered. Neither may
    // come back here: the sidebar is window furniture, and this is not.
    expect(screen.queryByLabelText('Set working directory')).toBeNull();
    expect(screen.queryByText('/w')).toBeNull();
  });

  it('is still offered in the status line', () => {
    mount(<StatusLine />);

    expect(screen.getByLabelText('Working directory — change it')).not.toBeNull();
  });

  it('leaves New session as the sidebar’s only header control besides hiding it', () => {
    mount(<Sidebar />);

    // The row is New session + the pane toggle. A third button in this header
    // is what the directory row used to be.
    expect(screen.getByText('New session')).not.toBeNull();
    expect(screen.queryByText(/Set working directory/)).toBeNull();
  });
});
