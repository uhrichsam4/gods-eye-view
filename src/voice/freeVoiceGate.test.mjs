import test from 'node:test';
import assert from 'node:assert/strict';

import { matchLocally, shouldUseFreeVoice } from './freeVoice.js';

test('free voice takes over when Realtime cannot run', () => {
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: true }), true);
});

test('free voice stands aside when Realtime is actually available', () => {
  assert.equal(shouldUseFreeVoice({ realtimeReady: true, speechSupported: true }), false);
});

test('a missing OpenRouter key does NOT disable voice', () => {
  // THE REGRESSION THIS GUARDS. The old gate also required the OpenRouter key,
  // which is absent in production because it lives in a gitignored .env. The
  // free path never bound, the microphone stayed on the OpenAI Realtime
  // controller, and clicking it told the user "OPENAI_API_KEY is not set" —
  // a key they had no way to supply. The predicate must not consider it.
  assert.equal(
    shouldUseFreeVoice({ realtimeReady: false, speechSupported: true, aiConfigured: false }),
    true
  );
  // And it must reach the same answer whatever that flag says.
  assert.equal(
    shouldUseFreeVoice({ realtimeReady: false, speechSupported: true, aiConfigured: true }),
    shouldUseFreeVoice({ realtimeReady: false, speechSupported: true, aiConfigured: false })
  );
});

test('a browser without speech support gets no free voice', () => {
  // Firefox has no SpeechRecognition; binding the mic there would be a button
  // that silently does nothing.
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: false }), false);
});

test('Realtime wins over free voice even on an unsupported browser', () => {
  assert.equal(shouldUseFreeVoice({ realtimeReady: true, speechSupported: false }), false);
});

test('an absent state object never binds the microphone', () => {
  assert.equal(shouldUseFreeVoice(), false);
  assert.equal(shouldUseFreeVoice({}), false);
});

test('only a literal true for speech support counts', () => {
  // Guards against a truthy-but-wrong value (a string, an object) being read
  // as support and binding a microphone that cannot listen.
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: 'yes' }), false);
  assert.equal(shouldUseFreeVoice({ realtimeReady: false, speechSupported: 1 }), false);
});

// ---------------------------------------------------------------------------
// The local matcher. This is what makes voice work with no API key at all, so
// its coverage is the difference between a microphone that responds and one
// that only apologises.
// ---------------------------------------------------------------------------

test('navigation is understood without any language model', () => {
  // THE GAP THIS CLOSES. Navigation is the most-used command and it matched
  // nothing locally, so on a deployment with no parser key "fly to Tokyo" —
  // the example the fallback message itself suggested — did nothing.
  for (const phrase of [
    'fly to Tokyo', 'take me to Paris', 'go to Cairo',
    'navigate to Oslo', 'travel to Lima', 'head to Perth',
  ]) {
    const m = matchLocally(phrase);
    assert.equal(m?.action, 'fly_to_location', `"${phrase}" did not navigate`);
    assert.ok(m.args.query, `"${phrase}" produced no place`);
  }
});

test('the place is passed as `query`, the name the action runner reads', () => {
  // flyToRequestedLocation reads args.query. A different key fails silently:
  // the camera simply never moves and nothing reports an error.
  const m = matchLocally('fly to Reykjavik');
  assert.deepEqual(Object.keys(m.args), ['query']);
  assert.equal(m.args.query, 'reykjavik');
});

test('a layer name is never mistaken for a destination', () => {
  // "take me to the shootings" means show that layer, not geocode the word.
  // Without this guard the camera flies off to wherever Google resolves it.
  assert.equal(matchLocally('take me to the shootings'), null);
  assert.equal(matchLocally('go to traffic'), null);
});

test('trailing punctuation does not become part of the place name', () => {
  assert.equal(matchLocally('fly to Berlin.').args.query, 'berlin');
  assert.equal(matchLocally('take me to Rome!').args.query, 'rome');
});

test('an absurdly long utterance is not sent to the geocoder', () => {
  assert.equal(matchLocally(`fly to ${'x'.repeat(200)}`), null);
});

test('layer toggles still win over navigation', () => {
  assert.equal(matchLocally('show shootings')?.action, 'set_layer_visibility');
  assert.equal(matchLocally('hide temperature')?.action, 'set_layer_visibility');
  assert.equal(matchLocally('turn on cameras')?.args.layerId, 'cctv');
  assert.equal(matchLocally('turn the cameras on')?.args.layerId, 'cctv');
  assert.equal(matchLocally('switch the radio off')?.args.layerId, 'radio');
});

test('layer visibility uses `enabled`, the name the handler checks', () => {
  // `visible` was the intuitive guess and it fails silently.
  const m = matchLocally('show shootings');
  assert.equal(m.args.enabled, true);
  assert.equal(matchLocally('hide shootings').args.enabled, false);
  assert.equal(matchLocally('switch the radio off').args.enabled, false);
});

test('view commands resolve locally', () => {
  assert.equal(matchLocally('reset view')?.action, 'zoom_to_globe');
  assert.equal(matchLocally('zoom out')?.action, 'zoom_to_globe');
  assert.equal(matchLocally('zoom in')?.action, 'adjust_camera_zoom');
  assert.equal(matchLocally('look down')?.action, 'frame_overhead');
  assert.equal(matchLocally('stop tracking')?.action, 'stop_tracking');
});

test('incident questions route to search, not navigation', () => {
  // "worst shooting in Florida" names a place but is a search; geocoding
  // Florida and flying there would answer a different question.
  assert.equal(matchLocally('what was the worst shooting in Florida')?.action, 'find_incident');
  assert.equal(matchLocally('show me the deadliest massacre')?.action, 'find_incident');
});

test('nonsense and open questions match nothing', () => {
  assert.equal(matchLocally('blorp the quux'), null);
  assert.equal(matchLocally('what is the meaning of life'), null);
  assert.equal(matchLocally(''), null);
  assert.equal(matchLocally(null), null);
});
