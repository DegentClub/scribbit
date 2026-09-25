import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  try {
    globalThis.sessionStorage?.clear();
  } catch {
    /* storage may be unavailable */
  }
});

if (typeof window !== "undefined") window.scrollTo = () => undefined;
