/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { act, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { beforeEach, describe, expect, it } from 'vitest';
import '../i18n';
import { usePrefs } from '../prefs/store';
import { emitFx } from './bus';
import { FxOverlay } from './Overlay';

beforeEach(() =>
  usePrefs.setState({ sound: false, music: false, intensity: 'normal', reducedMotion: 'off' }),
);

describe('FxOverlay', () => {
  it('is a non-blocking portal: pointer-events none layer, decorative layers aria-hidden', () => {
    render(<FxOverlay />);
    const root = screen.getByTestId('fx-root');
    expect(root.parentElement).toBe(document.body);
    expect(root.className).toContain('fx-root');
    expect(root.querySelectorAll('canvas[aria-hidden="true"]').length).toBe(2);
    // css contract: the layer and all descendants ignore pointer input
    const text = readFileSync('apps/web/src/index.css', 'utf8'); // vitest runs from the repo root
    expect(text).toMatch(/\.fx-root\s*{[^}]*pointer-events:\s*none/);
    expect(text).toMatch(/\.fx-root \*\s*{[^}]*pointer-events:\s*none/);
  });

  it('announces cue text via ARIA-live and spawns decorative floaters', async () => {
    render(<FxOverlay />);
    await act(async () => emitFx('vote_submitted'));
    expect(screen.getByRole('status').textContent).toBe('Your vote was sent: a star flies up.');
    const floater = document.querySelector('.fx-float');
    expect(floater?.getAttribute('aria-hidden')).toBe('true');
  });

  it('reduced motion: no floaters, but the text equivalent is announced and visibly captioned', async () => {
    usePrefs.setState({ reducedMotion: 'on' });
    render(<FxOverlay />);
    await act(async () => emitFx('grand_winner'));
    expect(document.querySelector('.fx-float')).toBeNull();
    expect(screen.getAllByText(/golden fireworks/).length).toBeGreaterThanOrEqual(2); // live region + visible caption
  });

  it('has no axe violations', async () => {
    document.documentElement.lang = 'en';
    document.title = 'FX';
    render(<FxOverlay />);
    await act(async () => emitFx('participant_joined'));
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => v.id)).toEqual([]);
  });
});
