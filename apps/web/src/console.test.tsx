import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import i18n from './i18n';
import { mountConsole } from './test-utils';
import { parseTab } from './components/organizer/console/types';
import { nextPhase, prevPhase } from './pages/Console';

beforeEach(() => i18n.changeLanguage('en'));
afterEach(() => vi.unstubAllGlobals());

const tab = (name: string) => screen.getByRole('tab', { name });
const selected = () =>
  screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')!;

describe('organizer console shell', () => {
  it('defaults to the Live tab with the summary, manual override and a "Manual" autopilot chip', async () => {
    mountConsole({ phase: 'registration' });
    await screen.findByRole('heading', { name: 'Office Party' });
    expect(selected().textContent).toBe('Live');
    const panel = screen.getByRole('tabpanel');
    expect(panel.getAttribute('aria-labelledby')).toBe(selected().id);
    expect(within(panel).getByTestId('live-cockpit')).toBeTruthy();
    expect(within(panel).getByRole('heading', { name: 'Manual override' })).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'Next: Gift registration' })).toBeTruthy();
    expect(within(screen.getByTestId('autopilot-chip-slot')).getByText('Manual')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Create a display link (People tab)' })).toBeTruthy();
  });

  it('?tab= deep-links a tab; unknown values fall back to Live', async () => {
    mountConsole({ phase: 'registration', tab: 'setup' });
    expect(await screen.findByTestId('features-panel')).toBeTruthy();
    expect(selected().textContent).toBe('Setup');
    expect(screen.queryByTestId('manual-override')).toBeNull();
    expect(parseTab('admin')).toBe('admin');
    expect(parseTab('nope')).toBe('live');
    expect(parseTab(null)).toBe('live');
  });

  it('clicking and arrow keys switch tabs (roving tabindex, Home/End)', async () => {
    mountConsole({ phase: 'registration' });
    await screen.findByRole('heading', { name: 'Office Party' });
    fireEvent.click(tab('People'));
    expect(await screen.findByRole('heading', { name: 'Invitations' })).toBeTruthy();
    expect(tab('People').tabIndex).toBe(0);
    expect(tab('Live').tabIndex).toBe(-1);

    fireEvent.keyDown(tab('People'), { key: 'ArrowRight' });
    expect(selected().textContent).toBe('Show');
    expect(document.activeElement).toBe(tab('Show'));
    fireEvent.keyDown(tab('Show'), { key: 'End' });
    expect(selected().textContent).toBe('Admin');
    fireEvent.keyDown(tab('Admin'), { key: 'ArrowRight' });
    expect(selected().textContent).toBe('Live');
    fireEvent.keyDown(tab('Live'), { key: 'ArrowLeft' });
    expect(selected().textContent).toBe('Admin');
    fireEvent.keyDown(tab('Admin'), { key: 'Home' });
    expect(selected().textContent).toBe('Live');
  });

  it('stepper: past phases done, current highlighted with aria-current, rest upcoming', async () => {
    mountConsole({ phase: 'voting' });
    await screen.findByRole('heading', { name: 'Office Party' });
    const nav = screen.getByRole('navigation', { name: 'Event phases' });
    const steps = within(nav).getAllByRole('listitem');
    expect(steps).toHaveLength(9);
    expect(screen.getByTestId('step-voting').getAttribute('aria-current')).toBe('step');
    expect(screen.getByTestId('step-voting').dataset.state).toBe('current');
    for (const p of ['preparation', 'registration', 'gift_registration', 'gift_opening'])
      expect(screen.getByTestId(`step-${p}`).dataset.state).toBe('done');
    for (const p of ['games', 'reveal', 'awards', 'completed'])
      expect(screen.getByTestId(`step-${p}`).dataset.state).toBe('todo');
    expect(nav.querySelectorAll('[aria-current]')).toHaveLength(1);
  });

  it('show tab puts the current-phase panel first', async () => {
    mountConsole({ phase: 'voting', tab: 'show', features: { auction: false, coins: false } });
    await screen.findByTestId('show-voting');
    const order = Array.from(
      screen.getByRole('tabpanel').querySelectorAll('[data-testid^="show-"]'),
    ).map((e) => e.getAttribute('data-testid'));
    expect(order[0]).toBe('show-voting');
    expect(order).toContain('show-boards');
  });

  it('header and tabs have no axe violations', async () => {
    mountConsole({ phase: 'gift_opening' });
    await screen.findByTestId('live-cockpit');
    const res = await axe.run(document.documentElement, {
      rules: { 'color-contrast': { enabled: false } },
    });
    expect(res.violations.map((v) => `${v.id}: ${v.nodes[0]?.html}`)).toEqual([]);
  });

  it('nextPhase / prevPhase stay exported from the page', () => {
    expect(nextPhase('voting')).toBe('games');
    expect(prevPhase('preparation')).toBeUndefined();
  });
});
