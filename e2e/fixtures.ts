import { test as base, expect } from '@playwright/test';

/** Shared test base for the suites, so a page-wide setup has one place to go. */
export const test = base;

export { expect };
