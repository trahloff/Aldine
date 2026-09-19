import { describe, it, expect } from 'vitest';
import {
  autoTypesetDelay, electTypesetter, shouldAdoptRun,
  LOCAL_AUTO_TYPESET_MS, AGENT_AUTO_TYPESET_MS, type TypesetPeer,
} from '../autoTypeset';

describe('autoTypesetDelay', () => {
  it('arms nothing while the auto-typeset toggle is off', () => {
    expect(autoTypesetDelay({ source: 'local', auto: false, hasTex: true })).toBeNull();
    expect(autoTypesetDelay({ source: 'agent', auto: false, hasTex: true })).toBeNull();
  });

  it('arms nothing in a project with no .tex to typeset', () => {
    expect(autoTypesetDelay({ source: 'local', auto: true, hasTex: false })).toBeNull();
    expect(autoTypesetDelay({ source: 'agent', auto: true, hasTex: false })).toBeNull();
  });

  it('uses the keystroke delay for a local edit and the longer one for an agent edit', () => {
    expect(autoTypesetDelay({ source: 'local', auto: true, hasTex: true })).toBe(LOCAL_AUTO_TYPESET_MS);
    expect(autoTypesetDelay({ source: 'agent', auto: true, hasTex: true })).toBe(AGENT_AUTO_TYPESET_MS);
  });

  it('keeps the agent window longer than the local one', () => {
    // The ordering is the behaviour: an agent that typesets right after its
    // edit must win the race, so this client never runs a second latexmk.
    expect(AGENT_AUTO_TYPESET_MS).toBeGreaterThan(LOCAL_AUTO_TYPESET_MS);
  });
});

describe('electTypesetter', () => {
  const peer = (clientId: number, eligible = true, visible = true): TypesetPeer => ({ clientId, eligible, visible });

  it('elects nobody when there are no peers', () => {
    expect(electTypesetter([])).toBeNull();
  });

  it('elects nobody when no peer is eligible', () => {
    expect(electTypesetter([peer(1, false), peer(2, false)])).toBeNull();
  });

  it('elects the only eligible client', () => {
    expect(electTypesetter([peer(7)])).toBe(7);
  });

  it('never elects an ineligible client, even the lowest id', () => {
    expect(electTypesetter([peer(1, false), peer(9)])).toBe(9);
  });

  it('prefers a visible tab over a lower-id background one', () => {
    expect(electTypesetter([peer(1, true, false), peer(9, true, true)])).toBe(9);
  });

  it('falls back to the lowest id when every tab is in the background', () => {
    expect(electTypesetter([peer(9, true, false), peer(3, true, false)])).toBe(3);
  });

  it('elects the same client whatever order the peers arrive in', () => {
    // Determinism is what removes the round trip: every tab computes the
    // winner locally from the same awareness and they agree without asking.
    const peers = [peer(4, true, false), peer(8), peer(2, false), peer(6)];
    const shuffled = [peers[2], peers[3], peers[0], peers[1]];
    expect(electTypesetter(peers)).toBe(electTypesetter(shuffled));
    expect(electTypesetter(peers)).toBe(6);
  });
});

describe('shouldAdoptRun', () => {
  it('refuses while this client is compiling, even for a newer run', () => {
    expect(shouldAdoptRun(1, 2, true)).toBe(false);
  });

  it('refuses when the server reports no runId (an older server)', () => {
    expect(shouldAdoptRun(1, undefined, false)).toBe(false);
    expect(shouldAdoptRun(undefined, undefined, false)).toBe(false);
  });

  it('adopts a run when the preview shows none yet', () => {
    expect(shouldAdoptRun(undefined, 5, false)).toBe(true);
  });

  it('adopts a newer run and ignores the one already on screen', () => {
    expect(shouldAdoptRun(5, 6, false)).toBe(true);
    expect(shouldAdoptRun(5, 5, false)).toBe(false);
    expect(shouldAdoptRun(5, 4, false)).toBe(false);
  });
});
