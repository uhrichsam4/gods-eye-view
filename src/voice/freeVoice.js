/**
 * Free voice commands.
 *
 * Speech in, speech out, intent parsing — all at zero cost and with no OpenAI
 * account:
 *
 *   you speak  -> SpeechRecognition        (browser, local, free)
 *              -> /api/openrouter/chat     (free-tier model, server-side key)
 *              -> runGevAction(...)        (the app's existing 28 actions)
 *              -> speechSynthesis          (browser, local, free)
 *
 * WHY LOCAL FOR THE AUDIO ENDS. Measured in this app: 145 ms from `speak()` to
 * audio starting, which matches the fastest commercial TTS on the market —
 * because there is no network call at all. Nothing that crosses the wire can
 * beat it, and every paid option has to. The trade is voice quality, which for
 * short HUD confirmations is a trade worth making.
 *
 * ONLY THE INTENT STEP IS REMOTE, and it is a few hundred tokens against a
 * free model. If OpenRouter is unreachable the module still works for the
 * commands the local matcher recognises — see `matchLocally`.
 *
 * BROWSER SUPPORT: SpeechRecognition is Chrome and Edge. Firefox does not ship
 * it, and this module reports that rather than failing silently. Speech OUTPUT
 * works everywhere.
 */

import { createGevActionRunner } from './gevActions.js';

/** Where intent parsing happens. */
import {
  buildAgentPrompt,
  createAgentLoop,
  looksCompound,
  looksConversational,
  stripWakeWords,
} from './freeAgent.js';

const CHAT_URL = '/api/openrouter/chat';
/** A free model that has not answered in this long is not going to. */
const CHAT_TIMEOUT_MS = 20000;

/** Longest a command will wait for the startup camera restore to settle. */
const STARTUP_WAIT_CAP_MS = 8000;

/** Actions that move the camera, and so lose a race against startup restore. */
const CAMERA_ACTIONS = new Set([
  'fly_to_location', 'fly_route', 'zoom_to_globe', 'frame_overhead',
  'move_camera', 'adjust_camera_zoom', 'track_entity',
  'select_nearest_aircraft', 'find_incident',
]);

/**
 * Every action the voice layer can invoke.
 *
 * ARGUMENT NAMES ARE READ FROM gevActions.js, NOT GUESSED. Several are not what
 * you would assume: set_layer_visibility takes `enabled`, not `visible`, and
 * fly_to_location takes `query`, not `target`. A wrong argument name fails
 * silently — the action runs and does nothing — so these were checked against
 * the handlers one by one.
 */
const VOICE_ACTIONS = Object.freeze([
  // Navigation
  { name: 'fly_to_location', args: 'query (place name), rangeM (optional metres)', hint: 'go to / fly to / show me a place' },
  { name: 'zoom_to_globe', args: '(none)', hint: 'zoom out to the whole planet' },
  { name: 'frame_overhead', args: '(none)', hint: 'look straight down' },
  { name: 'move_camera', args: 'direction, amount', hint: 'pan or nudge the camera' },
  { name: 'adjust_camera_zoom', args: 'direction ("in"/"out"), amount', hint: 'zoom in or out a bit' },
  { name: 'fly_route', args: 'points (list of place names)', hint: 'fly a path through several places' },

  // Tracking
  { name: 'track_entity', args: 'query (callsign, ship or vehicle name)', hint: 'follow a specific aircraft or ship' },
  { name: 'stop_tracking', args: '(none)', hint: 'stop following whatever is tracked' },
  { name: 'select_nearest_aircraft', args: 'layerId, locationQuery', hint: 'pick the closest aircraft to a place' },

  // Layers and panels
  { name: 'set_layer_visibility', args: 'layerId, enabled (bool)', hint: 'turn a data layer on or off' },
  { name: 'show_data_layers_menu', args: '(none)', hint: 'show the data layers list' },
  { name: 'set_panel_open', args: 'panelId, open (bool)', hint: 'open or close a named panel' },
  { name: 'set_map_stack', args: 'stack', hint: 'switch the basemap' },
  { name: 'set_context_mode', args: 'mode ("contacts" or "space")', hint: 'switch the CONTEXT panel mode' },

  // Look and feel
  { name: 'set_visual_style', args: 'style (normal, retro, surveillance, thermal, anime, noir, snow)', hint: 'change the visual style' },
  { name: 'set_hud', args: 'visible (bool), layout (tactical/operator/minimal)', hint: 'show, hide or relayout the HUD' },
  { name: 'set_detection', args: 'enabled (bool), mode, densityPct', hint: 'the detection overlay' },
  { name: 'set_post_processing', args: 'bloom (bool), sharpen (bool)', hint: 'bloom and sharpening' },

  // Features
  { name: 'control_cctv', args: 'action ("enable"/"disable"/"next"/"previous"/"nearest"/"focus")', hint: 'the camera feed' },
  { name: 'control_radio', args: 'action, country, stationQuery, locationQuery, category', hint: 'play or stop radio' },
  { name: 'control_scene', args: 'action ("play"/"stop"/"next")', hint: 'scene playback' },
  { name: 'control_cockpit', args: 'action ("enter"/"exit")', hint: 'ride along in a live aircraft' },
  { name: 'next_iss_pass', args: '(none)', hint: 'when the space station passes overhead' },

  // Annotation and questions
  { name: 'annotate_map', args: 'annotations (list of {label, query})', hint: 'mark or label places' },
  { name: 'clear_annotations', args: '(none)', hint: 'remove all marks' },
  { name: 'analyst_query', args: 'query', hint: 'ask a question about what is on screen' },
  { name: 'get_entity_context', args: '(none)', hint: 'describe the tracked contact' },
  { name: 'get_current_view_state', args: '(none)', hint: 'describe what is currently shown' },

  // Handled here rather than by the shared runner: it searches this app's own
  // incident dataset, flies to the match and opens its card.
  { name: 'find_incident', args: 'query (place, name, or a superlative like "worst in Florida")', hint: 'find a specific mass killing and show it' },
]);

/**
 * Layer ids the user is likely to name aloud, with the words they will use.
 *
 * The model is told these explicitly. Without them a free model guesses
 * "shootings" for the safety layer and "weather" for temperature.
 */
const LAYER_WORDS = Object.freeze({
  shootings: 'mass killings, shootings, mass shootings',
  safety: 'safety, safety index, danger, how safe',
  temperature: 'temperature, weather, how hot, how cold',
  cctv: 'cameras, cctv, security cameras',
  flights: 'flights, planes, aircraft, air traffic',
  military: 'military flights, military aircraft',
  earthquakes: 'earthquakes, quakes',
  satellites: 'satellites',
  'rocket-launches': 'rockets, launches',
  traffic: 'traffic',
  radio: 'radio, stations',
  'ais-live-vessels': 'ships, vessels, boats',
  'map-labels': 'labels, street names, place names',
});

/**
 * Whether the free voice path should take over the microphone.
 *
 * A PURE PREDICATE ON PURPOSE. This decision was previously inline in the
 * startup sequence and got it wrong in a way nobody could test: it also
 * required the OpenRouter key to be configured. That key lives in a gitignored
 * .env, so it is absent in production — the free path never bound, the mic
 * stayed wired to the OpenAI Realtime controller, and clicking it reported
 * "OPENAI_API_KEY is not set" to a user with no way to supply one.
 *
 * The key is irrelevant to whether voice can run. `matchLocally` resolves the
 * great majority of commands with no network call at all, and the parser is
 * consulted only for phrasings it does not recognise. A missing key narrows
 * what can be understood; it does not stop the microphone working.
 *
 * @param {{realtimeReady?: boolean, speechSupported?: boolean}} state
 * @returns {boolean}
 */
export function shouldUseFreeVoice({ realtimeReady = false, speechSupported = false } = {}) {
  // Realtime, when it is actually available, is the better path — leave it be.
  if (realtimeReady) return false;
  // Nothing to bind to without browser speech support.
  return speechSupported === true;
}

/**
 * Commands answerable without a round trip.
 *
 * Two reasons this exists rather than sending everything to the model. It is
 * instant, and it keeps working when OpenRouter is rate-limited — which, on the
 * free tier, is often.
 *
 * @param {string} text
 * @returns {{action: string, args: object, reply: string}|null}
 */
export function matchLocally(text) {
  const said = String(text || '').toLowerCase().trim();
  if (!said) return null;

  if (/\b(zoom out|whole (world|planet|globe)|show the globe|back to space)\b/.test(said)) {
    return { action: 'zoom_to_globe', args: {}, reply: 'Zooming out.' };
  }
  if (/\b(look down|straight down|overhead|top.?down)\b/.test(said)) {
    return { action: 'frame_overhead', args: {}, reply: 'Looking straight down.' };
  }
  if (/\b(stop (tracking|following)|untrack)\b/.test(said)) {
    return { action: 'stop_tracking', args: {}, reply: 'Stopped tracking.' };
  }
  if (/\b(reset|home|start over|default view)\b/.test(said)) {
    return { action: 'zoom_to_globe', args: {}, reply: 'Resetting the view.' };
  }
  if (/\b(zoom in|closer|move in)\b/.test(said)) {
    return { action: 'adjust_camera_zoom', args: { direction: 'in' }, reply: 'Zooming in.' };
  }

  // A named incident or a "worst in <place>" question is a search. Caught here
  // so it never gets mistaken for a navigation command.
  if (/\b(worst|deadliest|craziest|biggest)\b.*\b(shooting|killing|attack|massacre)\b/.test(said)
      || /\b(shooting|massacre|attack)\b/.test(said) && /\b(show|find|take me|what was|zoom)\b/.test(said)) {
    return { action: 'find_incident', args: { query: said }, reply: 'Finding it.' };
  }

  // Common natural phrasing: "turn on the cameras" and "turn the cameras on"
  // are both normal speech and both need to be treated the same. The local
  // matcher must understand both without falling through to geocoding.
  const turnToggleAfter = /\b(?:turn|switch)\s+(?:the\s+)?(.+?)\s+(on|off)\b/i.exec(said);
  if (turnToggleAfter) {
    const wantOn = /on/i.test(turnToggleAfter[2] || 'off');
    const phrase = turnToggleAfter[1].replace(/[.?!,]+$/, '').trim();
    if (phrase) {
      for (const [layerId, words] of Object.entries(LAYER_WORDS)) {
        if (words.split(',').some((w) => phrase.includes(w.trim()))) {
          return {
            action: 'set_layer_visibility',
            // `enabled`, not `visible` — checked against the handler in
            // gevActions.js. The wrong name fails silently.
            args: { layerId, enabled: wantOn },
            reply: `${wantOn ? 'Showing' : 'Hiding'} ${layerId.replace(/-/g, ' ')}.`,
          };
        }
      }
    }
  } else {
    const turnToggleBefore = /\b(?:turn|switch)\s+(on|off)\s+(?:the\s+)?(.+)$/i.exec(said);
    if (turnToggleBefore) {
      const wantOn = /on/i.test(turnToggleBefore[1] || 'off');
      const phrase = (turnToggleBefore[2] || '').replace(/[.?!,]+$/, '').trim();
      if (phrase) {
        for (const [layerId, words] of Object.entries(LAYER_WORDS)) {
          if (words.split(',').some((w) => phrase.includes(w.trim()))) {
            return {
              action: 'set_layer_visibility',
              args: { layerId, enabled: wantOn },
              reply: `${wantOn ? 'Showing' : 'Hiding'} ${layerId.replace(/-/g, ' ')}.`,
            };
          }
        }
      }
    }
  }

  const showToggle = /\b(show|hide)\s+(?:me\s+)?(?:the\s+)?(.+)$/i.exec(said);
  if (showToggle) {
    const wantOn = /show/i.test(showToggle[1] || 'hide');
    const phrase = (showToggle[2] || '').replace(/[.?!,]+$/, '').trim();
    if (phrase) {
      for (const [layerId, words] of Object.entries(LAYER_WORDS)) {
        if (words.split(',').some((w) => phrase.includes(w.trim()))) {
          return {
            action: 'set_layer_visibility',
            args: { layerId, enabled: wantOn },
            reply: `${wantOn ? 'Showing' : 'Hiding'} ${layerId.replace(/-/g, ' ')}.`,
          };
        }
      }
    }
  }
  // NAVIGATION. Deliberately last, so a layer name always wins: "take me to
  // the shootings" is a layer request, not a request to geocode the word
  // "shootings" and fly somewhere named after it.
  //
  // Only explicit movement verbs count. "show me X" is NOT among them —
  // it already means "turn on layer X" above, and letting it fall through to
  // geocoding would send the camera somewhere every time a layer name was
  // slightly off.
  //
  // This is the single most-used command and it needs no language model: the
  // action runner geocodes the place itself.
  const nav = /\b(?:fly|go|take me|navigate|travel|head)\s+(?:me\s+)?to\s+(?:the\s+)?(.+)$/.exec(said)
    || /\b(?:zoom to|center on|centre on|focus on)\s+(?:the\s+)?(.+)$/.exec(said);
  if (nav) {
    const place = nav[1].replace(/[.?!,]+$/, '').trim();
    const namesALayer = Object.values(LAYER_WORDS)
      .some((words) => words.split(',').some((w) => place === w.trim()));
    if (place && !namesALayer && place.length <= 80) {
      return {
        action: 'fly_to_location',
        // `query`, not `locationQuery` — checked against flyToRequestedLocation.
        args: { query: place },
        reply: `Flying to ${place}.`,
      };
    }
  }

  return null;
}

/**
 * The system prompt for intent parsing.
 *
 * Deliberately terse and example-led: a small free model follows a short prompt
 * with concrete examples far better than a long specification.
 *
 * @returns {string}
 */
function buildSystemPrompt() {
  const actions = VOICE_ACTIONS.map((a) => `${a.name}(${a.args}) — ${a.hint}`).join('\n');
  const layers = Object.entries(LAYER_WORDS).map(([id, words]) => `${id} = ${words}`).join('\n');
  return [
    'You convert a spoken command about a 3D world map into ONE action.',
    'Reply with STRICT JSON only. No markdown, no code fence, no commentary.',
    '',
    'Shape: {"action":"<name>","args":{...},"reply":"<max 8 words spoken back>"}',
    'If nothing fits, use {"action":"none","args":{},"reply":"..."} and say why briefly.',
    '',
    'ACTIONS:',
    actions,
    '',
    'LAYER IDS (use the id, never the spoken words):',
    layers,
    '',
    'EXAMPLES',
    '"fly to tokyo" -> {"action":"fly_to_location","args":{"query":"Tokyo"},"reply":"Flying to Tokyo."}',
    '"turn on the shootings" -> {"action":"set_layer_visibility","args":{"layerId":"shootings","enabled":true},"reply":"Mass killings layer on."}',
    '"how hot is it" -> {"action":"set_layer_visibility","args":{"layerId":"temperature","enabled":true},"reply":"Showing temperature."}',
    '"play radio from japan" -> {"action":"control_radio","args":{"action":"play","country":"Japan"},"reply":"Tuning Japan."}',
    '"make it look retro" -> {"action":"set_visual_style","args":{"style":"retro"},"reply":"Retro style on."}',
    '"follow flight BA249" -> {"action":"track_entity","args":{"query":"BA249"},"reply":"Tracking BA249."}',
    // A question ABOUT a place is a request to look at it WITH the relevant
    // layer on. Without this example the model only flies there, which answers
    // nothing.
    '"how safe is brazil" -> {"action":"set_layer_visibility","args":{"layerId":"safety","enabled":true},"reply":"Showing safety index."}',
    // Anything naming a specific incident, or asking which was worst somewhere,
    // is a search — not a place to fly to. Without these the model reaches for
    // fly_to_location and lands on the city with nothing shown.
    '"what was the worst shooting in florida" -> {"action":"find_incident","args":{"query":"worst shooting in Florida"},"reply":"Finding it."}',
    '"show me the miami school shooting" -> {"action":"find_incident","args":{"query":"miami school"},"reply":"Finding it."}',
    '"take me to the las vegas shooting" -> {"action":"find_incident","args":{"query":"las vegas"},"reply":"Finding it."}',
    '"what is the weather in cairo" -> {"action":"set_layer_visibility","args":{"layerId":"temperature","enabled":true},"reply":"Showing temperature."}',
    '"go back to space" -> {"action":"zoom_to_globe","args":{},"reply":"Zooming out."}',
  ].join('\n');
}

/**
 * Pull a JSON object out of a model reply.
 *
 * Free models wrap JSON in prose or a code fence however firmly you ask them
 * not to, so this takes the outermost braces rather than trusting the shape.
 *
 * @param {string} text
 * @returns {object|null}
 */
export function parseIntentJson(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (!parsed || typeof parsed.action !== 'string') return null;
    return {
      action: parsed.action,
      args: parsed.args && typeof parsed.args === 'object' ? parsed.args : {},
      reply: typeof parsed.reply === 'string' ? parsed.reply : '',
    };
  } catch {
    return null;
  }
}

/**
 * Pick the best available English voice.
 *
 * macOS ships around 180, most of them novelties (Bells, Boing, Zarvox). This
 * prefers the named quality voices and falls back to whatever is default.
 *
 * @param {Array<SpeechSynthesisVoice>} voices
 * @returns {SpeechSynthesisVoice|null}
 */
export function pickVoice(voices) {
  const english = (voices || []).filter((v) => String(v.lang || '').startsWith('en'));
  if (!english.length) return null;
  const preferred = ['Samantha', 'Daniel', 'Karen', 'Moira', 'Google US English'];
  for (const name of preferred) {
    const found = english.find((v) => v.name === name);
    if (found) return found;
  }
  return english.find((v) => v.default) || english[0];
}

/**
 * Create the free voice controller.
 *
 * @param {object} options
 * @returns {object} Controller.
 */
export function initFreeVoice({
  viewer, styleManager, dataManager, sceneDirector = null, annotations = null,
} = {}) {
  const runAction = createGevActionRunner({
    viewer, styleManager, dataManager, sceneDirector, annotations,
  });

  /**
   * Whether the free-tier intent parser is reachable.
   *
   * Only affects what we SAY when nothing matches. It must never gate whether
   * voice runs at all: the local matcher handles the great majority of
   * commands with no network call, so a deployment without an OpenRouter key
   * still has a working microphone — it just cannot interpret phrasings the
   * matcher has not seen.
   */
  let aiAvailable = true;

  /**
   * Wait for the app's startup camera restore to finish.
   *
   * A camera command issued during startup LOSES. The restore settles
   * asynchronously — measured still pending five seconds after load — and when
   * it lands it reasserts its own camera, cancelling whatever flight was in
   * progress. The symptom is a command that reports success while the globe
   * has not moved, which is exactly what "fly to Tokyo" did.
   *
   * Waiting is the fix rather than fighting it: the restore is the user's
   * remembered view, and a voice command should follow it, not race it.
   *
   * Capped, because a restore that never settles must not mute the microphone
   * forever — after the cap the command goes ahead and takes its chances.
   *
   * @returns {Promise<void>}
   */
  async function awaitStartupSettled() {
    const restore = styleManager?.initialRestorePromise;
    if (!restore || typeof restore.then !== 'function') return;
    await Promise.race([
      restore.catch(() => {}),
      new Promise((resolve) => { setTimeout(resolve, STARTUP_WAIT_CAP_MS); }),
    ]);
  }

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const supported = Boolean(SR) && Boolean(window.speechSynthesis);
  let recognition = null;
  let listening = false;
  let voice = null;
  /** @type {(state: string, text?: string) => void} */
  let onState = () => {};

  /** Voices populate asynchronously on some platforms. */
  function loadVoice() {
    if (!window.speechSynthesis) return;
    const apply = () => { voice = pickVoice(speechSynthesis.getVoices()); };
    apply();
    if (!voice) speechSynthesis.addEventListener('voiceschanged', apply, { once: true });
  }
  loadVoice();

  /**
   * Say something.
   *
   * @param {string} text
   * @returns {void}
   */
  function speak(text) {
    if (!window.speechSynthesis || !text) return;
    // Cancel anything queued: a backlog of stale confirmations talking over a
    // new command is worse than saying nothing.
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text));
    if (voice) utterance.voice = voice;
    utterance.rate = 1.05;
    speechSynthesis.speak(utterance);
  }


  /**
   * Handle one finished utterance.
   *
   * @param {string} transcript
   * @returns {Promise<void>}
   */
  /**
   * Run one action and report what happened.
   *
   * Shared by the instant local path and the agent loop, so a step behaves
   * identically however it was decided on.
   *
   * @param {{action: string, args: object}} step
   * @returns {Promise<object>}
   */
  async function execute(step) {
    // Camera commands must not race the startup restore; see
    // awaitStartupSettled. Non-camera commands (layers, styles, panels) are
    // unaffected and should not pay the wait.
    if (CAMERA_ACTIONS.has(step.action)) await awaitStartupSettled();

    // find_incident belongs to the shootings layer, not the shared runner.
    if (step.action === 'find_incident') {
      const shootings = dataManager?.layers?.get?.('shootings')?.module;
      if (typeof shootings?.findAndFocus !== 'function') {
        return { ok: false, error: 'Incident search is unavailable' };
      }
      const found = await shootings.findAndFocus(viewer, step.args?.query || '');
      return { ok: found.ok !== false, label: found.reply, text: found.reply };
    }
    return runAction(step.action, step.args || {});
  }

  /**
   * A short description of what is on screen, for the model's prompt.
   *
   * Cheap enough to include on every turn, and it means simple questions
   * ("is the temperature on?") are answered without spending a round on a
   * tool call to find out.
   *
   * @returns {string}
   */
  function describeState() {
    const lines = [];
    try {
      const layers = dataManager?.getAll?.() || [];
      const on = layers.filter((l) => l?.enabled).map((l) => l.id);
      lines.push(`layers on: ${on.length ? on.join(', ') : 'none'}`);
    } catch { /* the prompt is better off without it than broken */ }
    try {
      const camera = styleManager?.getCameraState?.();
      if (camera && Number.isFinite(camera.lat)) {
        lines.push(
          `camera: ${camera.lat.toFixed(1)}, ${camera.lon.toFixed(1)}`
          + ` at ${Math.round(camera.alt)} m`
        );
      }
    } catch { /* likewise */ }
    return lines.join('\n');
  }

  /**
   * One call to the free model.
   *
   * Given a timeout because the previous version had none: a free tier that
   * simply never answers left the microphone showing THINKING for as long as
   * the browser was willing to wait.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @returns {Promise<string>}
   */
  async function chat(messages) {
    const system = messages.find((m) => m.role === 'system')?.content || '';
    const rest = messages.filter((m) => m.role !== 'system');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHAT_TIMEOUT_MS);
    try {
      const response = await fetch(CHAT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system, messages: rest, maxTokens: 500 }),
        signal: controller.signal,
      });
      if (!response.ok) return '';
      const data = await response.json();
      return String(data?.text || '');
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  const agent = createAgentLoop({
    chat,
    execute,
    buildPrompt: () => buildAgentPrompt({
      actions: VOICE_ACTIONS.map((a) => `${a.name}(${a.args}) — ${a.hint}`).join('\n'),
      layers: Object.entries(LAYER_WORDS).map(([id, w]) => `${id} = ${w}`).join('\n'),
      state: describeState(),
    }),
    onSay: (text) => { onState('done', text); speak(text); },
    onStep: (step) => { onState('thinking', step.action.replace(/_/g, ' ')); },
  });

  /**
   * Handle one utterance.
   *
   * Two paths. A simple, single, recognised command runs instantly with no
   * network call at all. Anything compound, conversational, or unrecognised
   * goes to the agent loop, which can take several steps and answer questions
   * about what it found.
   *
   * @param {string} rawTranscript
   * @returns {Promise<void>}
   */
  async function handle(rawTranscript) {
    onState('heard', rawTranscript);
    const transcript = stripWakeWords(rawTranscript);
    if (!transcript) return;

    const multiPart = looksCompound(transcript) || looksConversational(transcript);

    // The fast path is deliberately skipped for compound requests. Its
    // navigation pattern takes everything after the verb as a place name, so
    // "fly to Miami and check the cameras" would be geocoded as a place called
    // "miami and check the cameras" — nothing is found and the cameras never
    // come on.
    if (!multiPart) {
      const intent = matchLocally(transcript);
      if (intent) {
        try {
          const result = await execute(intent);
          // These actions REPORT failure in their return value rather than
          // throwing: `{ ok: false, ... }`. Treating "did not throw" as success
          // meant the app cheerfully said "Flying to Tokyo" while the camera
          // had not moved — a confirmation for something that did not happen
          // is worse than an error.
          if (result && result.ok === false) {
            const why = result.cancelled ? 'that was interrupted'
              : result.error || result.reason || result.label || 'it did not work';
            onState('error', `${intent.action}: ${String(why).slice(0, 120)}`);
            speak(`Sorry, ${why}.`);
            return;
          }
          const reply = intent.reply || 'Done.';
          onState('done', reply);
          speak(reply);
        } catch (error) {
          // Say what failed rather than going quiet — silence after a command
          // is indistinguishable from not having been heard.
          onState('error', `That command failed. ${error?.message || error}`);
          speak('That command failed.');
        }
        return;
      }
    }

    if (!aiAvailable) {
      // NAME THE CAUSE. Saying only "I can only take set commands" tells
      // someone their phrasing was wrong when in fact nothing on this
      // deployment could have understood any phrasing — so they rephrase, and
      // rephrase, and conclude the feature is broken. It is not broken; it has
      // no model to call, which is a different problem with a different fix.
      const spoken = "I can't hold a conversation here — there's no AI model "
        + 'configured on this deployment. I can still take direct commands, '
        + 'like "fly to Tokyo" or "show shootings".';
      onState('idle', 'NO AI MODEL — set OPENROUTER_API_KEY to enable conversation');
      speak(spoken);
      return;
    }

    onState('thinking', transcript);
    const outcome = await agent.ask(transcript);
    if (outcome.failed && !outcome.spoke) {
      const reply = outcome.failed === 'round-cap'
        ? "I got partway through that but could not finish it."
        : "I didn't catch that.";
      onState('idle', reply);
      speak(reply);
    }
  }

  return {
    /**
     * Tell the layer whether the intent parser is reachable.
     *
     * @param {boolean} value
     */
    setAiAvailable(value) { aiAvailable = value !== false; },

    /** @returns {boolean} */
    isSupported() { return supported; },

    /** @returns {boolean} */
    isListening() { return listening; },

    /** Start a new conversation, forgetting what was said before. */
    resetConversation() { agent.reset(); },

    /** @returns {Array<object>} The conversation so far, for diagnostics. */
    conversation() { return agent.history(); },

    /** @param {Function} listener */
    onStateChange(listener) {
      onState = typeof listener === 'function' ? listener : () => {};
    },

    /** @returns {string} Why it cannot run, or ''. */
    unsupportedReason() {
      if (!window.speechSynthesis) return 'This browser has no speech synthesis.';
      if (!SR) return 'Speech recognition needs Chrome or Edge. Firefox does not support it.';
      return '';
    },

    /** @returns {boolean} Whether listening started. */
    start() {
      if (!supported || listening) return false;
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.continuous = true;
      // Interim results make the UI feel alive while someone is mid-sentence.
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;

      recognition.onresult = (event) => {
        for (let i = event.resultIndex; i < event.results.length; i += 1) {
          const result = event.results[i];
          const text = String(result[0]?.transcript || '').trim();
          if (!text) continue;
          if (result.isFinal) void handle(text);
          else onState('listening', text);
        }
      };
      recognition.onerror = (event) => {
        // 'no-speech' fires constantly during a pause and is not an error worth
        // reporting; anything else is.
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
          onState('error', `Microphone error: ${event.error}`);
        }
      };
      recognition.onend = () => {
        // Chrome stops recognition on its own after a silence. Restart while
        // the user still believes it is listening.
        if (listening) {
          try { recognition.start(); } catch { /* already starting */ }
        }
      };

      listening = true;
      try {
        recognition.start();
      } catch (error) {
        listening = false;
        onState('error', String(error?.message || error));
        return false;
      }
      onState('listening', '');
      return true;
    },

    /** @returns {void} */
    stop() {
      listening = false;
      try { recognition?.stop(); } catch { /* not started */ }
      recognition = null;
      speechSynthesis?.cancel();
      onState('idle', '');
    },

    /** Exposed for testing and for programmatic commands. */
    handle,
    speak,
  };
}

export default initFreeVoice;
