import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import { Picker, type PickerItem } from './Picker.js';

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30));

const items: readonly PickerItem[] = [
  { key: 'a', label: 'Alpha', detail: 'first' },
  { key: 'b', label: 'Beta', disabled: true, reason: 'not signed in' },
  { key: 'c', label: 'Gamma', danger: true },
];

describe('Picker', () => {
  it('lists every row, including disabled ones with their reason', async () => {
    const { lastFrame } = render(<Picker title="Pick" items={items} onSelect={() => undefined} onCancel={() => undefined} />);
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Pick');
    expect(frame).toContain('❯ Alpha');
    expect(frame).toContain('Beta');
    expect(frame).toContain('not signed in');
    expect(frame).toContain('Gamma');
  });

  it('opens on the initial key, moves with arrows, and will not select a disabled row', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = render(
      <Picker title="Pick" items={items} initialKey="c" onSelect={onSelect} onCancel={() => undefined} />,
    );
    await tick();
    expect(lastFrame()).toContain('❯ Gamma');
    stdin.write('[A'); // up → Beta (disabled)
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).not.toHaveBeenCalled();
    stdin.write('[A'); // up → Alpha
    await tick();
    stdin.write('\r');
    await tick();
    expect(onSelect).toHaveBeenCalledWith(items[0]);
  });

  it('Esc cancels without selecting', async () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const { stdin } = render(<Picker title="Pick" items={items} onSelect={onSelect} onCancel={onCancel} />);
    await tick();
    stdin.write('');
    await tick();
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
