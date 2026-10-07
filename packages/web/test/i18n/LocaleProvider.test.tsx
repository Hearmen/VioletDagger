import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LocaleProvider, useI18n } from '../../src/i18n/LocaleProvider';
import { LocaleToggle } from '../../src/components/LocaleToggle';

function Probe() {
  const { locale, t } = useI18n();
  return (
    <p data-testid="probe">
      {locale}:{t('messages.title')}
    </p>
  );
}

function renderWithProvider() {
  return render(
    <LocaleProvider>
      <Probe />
      <LocaleToggle />
    </LocaleProvider>,
  );
}

describe('LocaleProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to Chinese', () => {
    renderWithProvider();
    expect(screen.getByTestId('probe')).toHaveTextContent('zh:消息流');
    expect(document.documentElement.lang).toBe('zh-CN');
  });

  it('starts in English when localStorage says en', () => {
    window.localStorage.setItem('vd.locale', 'en');
    renderWithProvider();
    expect(screen.getByTestId('probe')).toHaveTextContent('en:Messages');
    expect(document.documentElement.lang).toBe('en');
  });

  it('falls back to Chinese on an invalid stored value', () => {
    window.localStorage.setItem('vd.locale', 'fr');
    renderWithProvider();
    expect(screen.getByTestId('probe')).toHaveTextContent('zh:消息流');
  });

  it('falls back to Chinese when reading storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    renderWithProvider();
    expect(screen.getByTestId('probe')).toHaveTextContent('zh:消息流');
  });

  it('toggles, persists the choice, and updates the html lang', () => {
    renderWithProvider();
    fireEvent.click(screen.getByRole('button', { name: '切换到英文' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('en:Messages');
    expect(window.localStorage.getItem('vd.locale')).toBe('en');
    expect(document.documentElement.lang).toBe('en');
    fireEvent.click(screen.getByRole('button', { name: 'Switch to Chinese' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('zh:消息流');
    expect(window.localStorage.getItem('vd.locale')).toBe('zh');
  });

  it('still switches when writing storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    renderWithProvider();
    fireEvent.click(screen.getByRole('button', { name: '切换到英文' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('en:Messages');
  });

  it('gives the default Chinese context outside a provider', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('zh:消息流');
  });
});

describe('LocaleToggle', () => {
  it('shows the target language', () => {
    renderWithProvider();
    const button = screen.getByRole('button', { name: '切换到英文' });
    expect(button).toHaveTextContent('EN');
    fireEvent.click(button);
    expect(screen.getByRole('button', { name: 'Switch to Chinese' })).toHaveTextContent('中');
  });
});
