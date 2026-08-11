/**
 * @vitest-environment jsdom
 *
 * Attaching images to a prompt.
 *
 * Three gestures put an image in the composer — paste, drop, and the picker —
 * and the one that matters is paste: taking a screenshot puts it on the
 * clipboard, and the next thing anyone does is Cmd+V. So the assertions here
 * are mostly about paste, and about the two things around it that are easy to
 * break without noticing:
 *
 *  - **A text paste must stay a text paste.** Copying a file in Finder puts the
 *    file *and* its name on the clipboard, and an over-eager `preventDefault`
 *    would eat the text of every path anyone ever pastes.
 *  - **The image must reach `submitPrompt`.** The strip rendering and the send
 *    are separate code paths, and a thumbnail on screen is not evidence that
 *    anything was attached to the request.
 *
 * `readImageFiles` is stubbed. It decodes bitmaps and paints a canvas, neither
 * of which jsdom has; what is under test is the composer's wiring, and the
 * decoding has its own home.
 */

import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

import { TooltipProvider } from '@/components/ui/tooltip';
import { Composer } from '@/components/Composer';
import { useApp } from '@/state/store';

class NoopObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', NoopObserver);
vi.stubGlobal('DOMRectReadOnly', class {});
Element.prototype.scrollIntoView ??= function scrollIntoView(): void {};

const ATTACHMENT = {
  kind: 'image' as const,
  id: 'img_1',
  mediaType: 'image/png' as const,
  data: 'aGVsbG8=',
  name: 'screenshot.png',
};

const readImageFiles = vi.hoisted(() => vi.fn());
vi.mock('@/lib/attachments', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attachments')>()),
  readImageFiles,
}));

const submitPrompt = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/state/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/state/store')>()),
  submitPrompt,
}));

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
  imageInput: true,
};

function setProvider(imageInput: boolean): void {
  useApp.setState({
    providers: [
      {
        id: 'claude',
        label: 'Test Provider',
        capabilities: { ...CAPABILITIES, imageInput },
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
}

beforeEach(() => {
  readImageFiles.mockReset();
  readImageFiles.mockResolvedValue({ accepted: [ATTACHMENT], rejected: [] });
  submitPrompt.mockClear();
  setProvider(true);
});

afterEach(cleanup);

function mount(ui: ReactNode): void {
  render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

/** A clipboard/drop payload carrying one file, as the DOM would present it. */
function transferWith(files: readonly File[]): DataTransfer {
  return {
    files: Object.assign(files.slice(), { item: (index: number) => files[index] ?? null }),
    types: files.length > 0 ? ['Files'] : [],
    items: [],
    getData: () => '',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

function pngFile(name = 'screenshot.png'): File {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

/** Returns false when a handler cancelled the paste — see the text-paste test. */
function pasteInto(element: Element, transfer: DataTransfer): boolean {
  return fireEvent.paste(element, { clipboardData: transfer });
}

describe('pasting an image', () => {
  it('attaches it and shows a thumbnail', async () => {
    mount(<Composer />);
    pasteInto(screen.getByLabelText('Prompt'), transferWith([pngFile()]));

    const thumb = await screen.findByAltText('screenshot.png');
    expect(thumb.getAttribute('src')).toBe('data:image/png;base64,aGVsbG8=');
  });

  it('leaves a text-only paste to the browser', () => {
    mount(<Composer />);
    // Not cancelled means the default ran, which is what puts the text in the
    // field. Cancelling this is how you break pasting a file path.
    const proceeded = pasteInto(screen.getByLabelText('Prompt'), transferWith([]));

    expect(proceeded).toBe(true);
    expect(readImageFiles).not.toHaveBeenCalled();
  });

  it('sends the image with the prompt, then clears the strip', async () => {
    mount(<Composer />);
    const field = screen.getByLabelText('Prompt');
    pasteInto(field, transferWith([pngFile()]));
    await screen.findByAltText('screenshot.png');

    fireEvent.change(field, { target: { value: 'what is wrong here?' } });
    fireEvent.click(screen.getByLabelText(/^Send the prompt/));

    expect(submitPrompt).toHaveBeenCalledWith('what is wrong here?', [ATTACHMENT]);
    // The attachment belonged to the prompt it went with; leaving it in the
    // field would silently put it on the next one too.
    await waitFor(() => {
      expect(screen.queryByAltText('screenshot.png')).toBeNull();
    });
  });

  it('can be taken back before it is sent', async () => {
    mount(<Composer />);
    pasteInto(screen.getByLabelText('Prompt'), transferWith([pngFile()]));
    await screen.findByAltText('screenshot.png');

    fireEvent.click(screen.getByLabelText('Remove screenshot.png'));

    await waitFor(() => {
      expect(screen.queryByAltText('screenshot.png')).toBeNull();
    });
  });
});

describe('a provider that cannot take images', () => {
  it('disables the attach button rather than hiding it', () => {
    // The house rule for capability gating: an unsupported control renders
    // disabled *with an explanation*, never silently missing.
    setProvider(false);
    mount(<Composer />);

    const attach = screen.getByLabelText('Attach an image');
    expect(attach.hasAttribute('disabled') || attach.getAttribute('aria-disabled') === 'true').toBe(
      true,
    );
  });

  it('refuses a pasted image instead of attaching one nothing will send', async () => {
    setProvider(false);
    mount(<Composer />);
    pasteInto(screen.getByLabelText('Prompt'), transferWith([pngFile()]));

    await waitFor(() => {
      expect(useApp.getState().banners.length).toBeGreaterThan(0);
    });
    expect(readImageFiles).not.toHaveBeenCalled();
    expect(screen.queryByAltText('screenshot.png')).toBeNull();
  });
});
