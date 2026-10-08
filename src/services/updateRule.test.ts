import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, shouldPrompt } from './updateRule';
import { locationPlan, type GeoPermission, type SavedPos } from './weather';

const base = { appBuild: 'aaa111', remoteBuild: 'bbb222', dismissed: '', manual: false };

test('update prompt: shown when the site serves a different build, with or without a service worker', () => {
  assert.equal(shouldPrompt(base), true);
});

test('update prompt: never for the same build, an unknown site build or a dev server', () => {
  assert.equal(shouldPrompt({ ...base, remoteBuild: 'aaa111' }), false);
  assert.equal(shouldPrompt({ ...base, remoteBuild: null }), false);
  assert.equal(shouldPrompt({ ...base, appBuild: 'dev' }), false);
});

test('update prompt: "Later" hides that build, a newer build asks again, and "Check for updates" always answers', () => {
  assert.equal(shouldPrompt({ ...base, dismissed: 'bbb222' }), false);
  assert.equal(shouldPrompt({ ...base, dismissed: 'bbb222', remoteBuild: 'ccc333' }), true);
  assert.equal(shouldPrompt({ ...base, dismissed: 'bbb222', manual: true }), true);
});

test('version.json is read strictly', () => {
  assert.equal(parseVersion({ build: 'a1b2c3d4e5f6' }), 'a1b2c3d4e5f6');
  for (const bad of [null, {}, { build: 5 }, { build: '' }, { build: '<script>' }, 'x']) assert.equal(parseVersion(bad), null);
});

/* ------------------------------ location: ask the device only when asking can work ------------------------------ */

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;
const pos = (ageMs: number): SavedPos => ({ lat: 14.6, lon: 121, at: NOW - ageMs });
const plan = (permission: GeoPermission, saved: SavedPos | null, failedAt = 0) => locationPlan({ permission, saved, failedAt, now: NOW });

test('location: a recent saved position is used and the device is not asked at all', () => {
  for (const p of ['granted', 'prompt', 'unknown', 'denied'] as GeoPermission[]) assert.equal(plan(p, pos(HOUR)), 'use-saved', p);
});

test('location: when the browser remembers the permission it refreshes quietly, and a refusal is never asked about again', () => {
  assert.equal(plan('granted', pos(12 * HOUR)), 'ask-device'); // silent: no question is shown
  assert.equal(plan('granted', null), 'ask-device');
  assert.equal(plan('denied', null), 'none');
  assert.equal(plan('denied', pos(12 * HOUR)), 'use-saved');
});

test('location: a browser that forgets the permission on every launch (phones, installed apps) does not make the reader answer each time', () => {
  assert.equal(plan('prompt', pos(3 * 24 * HOUR)), 'use-saved');
  assert.equal(plan('unknown', pos(20 * 24 * HOUR)), 'use-saved');
  assert.equal(plan('prompt', null), 'ask-device'); // the very first time
  assert.equal(plan('prompt', pos(40 * 24 * HOUR)), 'ask-device'); // a month-old position is too old to trust
});

test('location: after a refusal or timeout the device is left alone for an hour', () => {
  assert.equal(plan('prompt', null, NOW - 10 * 60_000), 'none');
  assert.equal(plan('granted', pos(12 * HOUR), NOW - 10 * 60_000), 'use-saved');
  assert.equal(plan('prompt', null, NOW - 2 * HOUR), 'ask-device');
});
