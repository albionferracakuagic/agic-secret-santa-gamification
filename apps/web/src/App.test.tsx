import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import './i18n';
import { App } from './App';

describe('App routes', () => {
  it.each([
    ['/o', 'Organizer console'],
    ['/e', 'Participant app'],
    ['/d', 'Public display'],
    ['/j', 'Join event'],
  ])('renders %s placeholder', (path, text) => {
    render(
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: text })).toBeTruthy();
  });
});
