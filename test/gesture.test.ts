// What the approve guard counts as fully visible, and as the mouse entering
// a frame. The guard itself runs in the browser (e2e/run.mjs). Run with
// `pnpm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FULLY_VISIBLE, fullyVisible, isMouseEntry } from '../src/security/gesture.ts';

test('fully visible: on screen as a whole, and reported visible (not covered, faded or transformed)', () => {
  assert.equal(fullyVisible({ isIntersecting: true, intersectionRatio: 1, isVisible: true }), true);
  assert.equal(fullyVisible({ isIntersecting: true, intersectionRatio: FULLY_VISIBLE, isVisible: true }), true);
  // Partly off screen or clipped by the embedding page.
  assert.equal(fullyVisible({ isIntersecting: true, intersectionRatio: 0.9, isVisible: true }), false);
  // Covered, faded or transformed, even in part.
  assert.equal(fullyVisible({ isIntersecting: true, intersectionRatio: 1, isVisible: false }), false);
  // A browser that does not say.
  assert.equal(fullyVisible({ isIntersecting: true, intersectionRatio: 1 }), false);
  assert.equal(fullyVisible({ isIntersecting: false, intersectionRatio: 0, isVisible: true }), false);
});

test('the mouse entering: a mouse pointerover that comes from no element of this document', () => {
  const inside = new EventTarget();
  const outside = new EventTarget();
  const inThisDocument = (target: EventTarget) => target === inside;
  // From the embedding page (cross-document: no related target), or from an element elsewhere.
  assert.equal(isMouseEntry({ pointerType: 'mouse', relatedTarget: null }, inThisDocument), true);
  assert.equal(isMouseEntry({ pointerType: 'mouse', relatedTarget: outside }, inThisDocument), true);
  // Moving between elements of this page.
  assert.equal(isMouseEntry({ pointerType: 'mouse', relatedTarget: inside }, inThisDocument), false);
  // Touch and pen have no pointer resting over the page.
  assert.equal(isMouseEntry({ pointerType: 'touch', relatedTarget: null }, inThisDocument), false);
  assert.equal(isMouseEntry({ pointerType: 'pen', relatedTarget: null }, inThisDocument), false);
});
