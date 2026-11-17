import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom has no canvas: FX hosts treat a null 2D context as "nothing to draw".
HTMLCanvasElement.prototype.getContext = (() => null) as never;

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.body.innerHTML = '';
});
