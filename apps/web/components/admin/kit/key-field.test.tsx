// @vitest-environment jsdom
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { suggestKey } from '@/lib/admin/key-suggestion';
import { KeyField } from './key-field';
import { renderKit } from './kit-test-utils';

afterEach(cleanup);

describe('suggestKey (E4)', () => {
  it('slugs the English label', () => {
    expect(suggestKey('Access Control & Intrusion')).toBe('access-control-intrusion');
    expect(suggestKey('  Café Wi-Fi (Level 2) ')).toBe('cafe-wi-fi-level-2');
    expect(suggestKey('Camera ID', [], { separator: '_' })).toBe('camera_id');
  });

  it('adds -2, -3… on a collision with any existing key, archived ones included', () => {
    expect(suggestKey('Network', ['network'])).toBe('network-2');
    expect(suggestKey('Network', ['network', 'network-2', 'NETWORK-3'])).toBe('network-4');
    // The separator of the key is kept in the suffix, as the API generates it.
    expect(suggestKey('Camera ID', ['camera_id'], { separator: '_' })).toBe('camera_id_2');
  });

  it('keeps the suffix within the maximum length', () => {
    const long = 'Very long category name that keeps going and going and going';
    const first = suggestKey(long, [], { maxLength: 20 });
    expect(first.length).toBeLessThanOrEqual(20);
    const second = suggestKey(long, [first], { maxLength: 20 });
    expect(second.length).toBeLessThanOrEqual(20);
    expect(second.endsWith('-2')).toBe(true);
  });

  it("returns '' when the label has nothing usable (the API generates one)", () => {
    expect(suggestKey('الشبكات')).toBe('');
    expect(suggestKey('')).toBe('');
  });
});

function Harness({
  mode,
  initial = '',
  onFollowingChange,
}: {
  mode: 'create' | 'edit';
  initial?: string;
  onFollowingChange?: (following: boolean) => void;
}) {
  const [label, setLabel] = useState('');
  const [key, setKey] = useState(initial);
  return (
    <>
      <label htmlFor="label">English name</label>
      <input id="label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <KeyField
        id="key"
        mode={mode}
        value={key}
        onChange={setKey}
        source={label}
        takenKeys={['network', 'cloud']}
        onFollowingChange={onFollowingChange}
      />
    </>
  );
}

describe('KeyField', () => {
  it('follows the English name while creating, with the collision suffix', () => {
    renderKit(<Harness mode="create" />);
    const label = screen.getByLabelText('English name');
    const key = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
    fireEvent.change(label, { target: { value: 'Network' } });
    expect(key.value).toBe('network-2');
    fireEvent.change(label, { target: { value: 'Network & Wi-Fi' } });
    expect(key.value).toBe('network-wi-fi');
    expect(key.readOnly).toBe(false);
    expect(key.getAttribute('dir')).toBe('ltr');
    expect(screen.getByText(/Made from the English name/)).toBeTruthy();
  });

  it('stops following once the admin types a key, and resumes when left empty', () => {
    renderKit(<Harness mode="create" />);
    const label = screen.getByLabelText('English name');
    const key = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
    fireEvent.change(label, { target: { value: 'Cloud' } });
    expect(key.value).toBe('cloud-2');
    fireEvent.change(key, { target: { value: 'Cloud-Services' } });
    expect(key.value).toBe('cloud-services');
    fireEvent.change(label, { target: { value: 'Cloud platforms' } });
    expect(key.value).toBe('cloud-services');

    fireEvent.change(key, { target: { value: '' } });
    fireEvent.blur(key);
    expect(key.value).toBe('cloud-platforms');
  });

  it('tells the form whether the key is still the suggestion (then the API picks it)', () => {
    const onFollowingChange = vi.fn();
    renderKit(<Harness mode="create" onFollowingChange={onFollowingChange} />);
    const key = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
    fireEvent.change(screen.getByLabelText('English name'), { target: { value: 'Cloud' } });
    expect(onFollowingChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(key, { target: { value: 'cloud-ops' } });
    expect(onFollowingChange).toHaveBeenLastCalledWith(false);
    fireEvent.change(key, { target: { value: '' } });
    fireEvent.blur(key);
    expect(onFollowingChange).toHaveBeenLastCalledWith(true);
    expect(key.value).toBe('cloud-2');
  });

  it('is read-only after creation (E4)', () => {
    renderKit(<Harness mode="edit" initial="cyber" />);
    const label = screen.getByLabelText('English name');
    const key = screen.getByRole('textbox', { name: 'Key' }) as HTMLInputElement;
    expect(key.readOnly).toBe(true);
    expect(key.getAttribute('aria-readonly')).toBe('true');
    expect(screen.getByText('The key can’t change after creation.')).toBeTruthy();
    fireEvent.change(label, { target: { value: 'Security' } });
    fireEvent.change(key, { target: { value: 'security' } });
    expect(key.value).toBe('cyber');
  });
});
