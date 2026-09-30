// @vitest-environment jsdom
import { zodResolver } from '@hookform/resolvers/zod';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { BilingualField, RhfBilingualField } from './bilingual-field';
import { renderKit, stubBrowserApis } from './kit-test-utils';
import { LanguageSwitch, LanguageTag, contentLanguageProps } from './language-switch';
import { WhoCanSeeNote } from './who-can-see-note';

beforeAll(stubBrowserApis);
afterEach(cleanup);

function Controlled({ en = 'Network', ar = '' }: { en?: string; ar?: string }) {
  const [valueEn, setEn] = useState(en);
  const [valueAr, setAr] = useState(ar);
  return (
    <BilingualField
      id="label"
      label="Name"
      required
      valueEn={valueEn}
      valueAr={valueAr}
      onChangeEn={setEn}
      onChangeAr={setAr}
      hint="Shown on the New ticket form."
    />
  );
}

describe('BilingualField (E2)', () => {
  it('edits English and Arabic side by side with their own direction and language', () => {
    renderKit(<Controlled />);
    const en = screen.getByRole('textbox', { name: 'Name English' });
    const ar = screen.getByRole('textbox', { name: 'Name العربية' });
    expect(en.getAttribute('dir')).toBe('ltr');
    expect(en.getAttribute('lang')).toBe('en');
    expect(ar.getAttribute('dir')).toBe('rtl');
    expect(ar.getAttribute('lang')).toBe('ar');
    expect(en.getAttribute('aria-required')).toBe('true');
    expect(ar.hasAttribute('aria-required')).toBe(false);
    expect(screen.getByRole('group', { name: 'Name' })).toBeTruthy();
  });

  it('says "Arabic missing — English is shown" while the Arabic is empty', () => {
    renderKit(<Controlled />);
    const ar = screen.getByRole('textbox', { name: 'Name العربية' });
    const hint = screen.getByText('Arabic missing — English is shown');
    expect(ar.getAttribute('aria-describedby')?.split(' ')).toContain(hint.id);
    fireEvent.change(ar, { target: { value: 'الشبكات' } });
    expect(screen.queryByText('Arabic missing — English is shown')).toBeNull();
    expect(ar.getAttribute('aria-describedby')?.split(' ')).not.toContain('label-ar-missing');
    // Whitespace is not a translation.
    fireEvent.change(ar, { target: { value: '   ' } });
    expect(screen.getByText('Arabic missing — English is shown')).toBeTruthy();
  });

  it('links errors and the hint to the right control', () => {
    renderKit(
      <BilingualField
        id="f"
        label="Title"
        valueEn=""
        valueAr="عنوان"
        onChangeEn={vi.fn()}
        onChangeAr={vi.fn()}
        errorEn="Enter an English title."
        hint="Short."
        multiline
      />,
    );
    const en = screen.getByRole('textbox', { name: 'Title English' });
    expect(en.tagName).toBe('TEXTAREA');
    expect(en.getAttribute('aria-invalid')).toBe('true');
    const described = en.getAttribute('aria-describedby')?.split(' ') ?? [];
    expect(described).toContain('f-en-error');
    expect(described).toContain('f-hint');
    expect(screen.getByText('Enter an English title.').id).toBe('f-en-error');
    expect(screen.queryByText('Arabic missing — English is shown')).toBeNull();
  });

  it('works with react-hook-form (values, blur and zod errors)', async () => {
    const onSubmit = vi.fn();
    function Form() {
      const form = useForm({
        resolver: zodResolver(
          z.object({ labelEn: z.string().min(1, 'English is required'), labelAr: z.string() }),
        ),
        defaultValues: { labelEn: '', labelAr: '' },
      });
      return (
        <form onSubmit={form.handleSubmit(onSubmit)}>
          <RhfBilingualField
            id="cat"
            label="Name"
            required
            control={form.control}
            nameEn="labelEn"
            nameAr="labelAr"
          />
          <button type="submit">Save</button>
        </form>
      );
    }
    renderKit(<Form />);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('English is required')).toBeTruthy();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Name English' }), {
      target: { value: 'Cloud' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Name العربية' }), {
      target: { value: 'السحابة' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ labelEn: 'Cloud', labelAr: 'السحابة' });
  });

  it('speaks Arabic in the Arabic UI (language tags stay in their own language)', () => {
    renderKit(<Controlled />, { locale: 'ar' });
    expect(screen.getByRole('textbox', { name: 'Name English' }).getAttribute('dir')).toBe('ltr');
    expect(screen.getByText('النص العربي غير موجود — يُعرض النص الإنجليزي')).toBeTruthy();
  });
});

describe('LanguageSwitch, LanguageTag, WhoCanSeeNote', () => {
  it('switches the content language (English | العربية radios)', () => {
    const onValueChange = vi.fn();
    renderKit(<LanguageSwitch value="en" onValueChange={onValueChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Content language' });
    const [en, ar] = [...group.querySelectorAll('[role="radio"]')];
    expect(en?.getAttribute('aria-checked')).toBe('true');
    expect(ar?.textContent).toBe('العربية');
    expect(ar?.querySelector('[lang="ar"]')?.getAttribute('dir')).toBe('rtl');
    fireEvent.click(ar!);
    expect(onValueChange).toHaveBeenCalledWith('ar');
    expect(contentLanguageProps('ar')).toEqual({ lang: 'ar', dir: 'rtl' });
    expect(contentLanguageProps('en')).toEqual({ lang: 'en', dir: 'ltr' });
  });

  it('tags a translatable field with its language', () => {
    renderKit(
      <>
        <LanguageTag language="en" />
        <LanguageTag language="ar" />
      </>,
    );
    expect(screen.getByText('English')).toBeTruthy();
    expect(screen.getByText('Arabic')).toBeTruthy();
  });

  it('notes who can see a restricted section', () => {
    const { unmount } = renderKit(<WhoCanSeeNote />);
    expect(screen.getByText(/Who can see this:/).parentElement?.textContent).toBe(
      'Who can see this: Only Super Admins can open this section.',
    );
    unmount();
    renderKit(<WhoCanSeeNote audience="teamLeads" />, { locale: 'ar' });
    expect(screen.getByText(/من يمكنه رؤية هذا:/).parentElement?.textContent).toContain(
      'قادة الفرق',
    );
  });
});
