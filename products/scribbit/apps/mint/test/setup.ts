import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  try {
    window.localStorage.clear();
  } catch {
    /* storage may be unavailable */
  }
});

let n = 0;
URL.createObjectURL = () => `blob:test/${++n}`;
URL.revokeObjectURL = () => undefined;
window.scrollTo = () => undefined;
