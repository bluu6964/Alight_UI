#!/usr/bin/env node
/**
 * Headless smoke test for the Motion Studio editor UI.
 *
 * Runs the real web app (app/src/main/assets/www) inside jsdom and walks the
 * main flows the way a person would: create a project, add layers, scrub,
 * split, undo, open every sheet, export, come back home. Fails loudly if the
 * page throws or an expected element is missing.
 *
 *   node tools/smoke-test.mjs            # run the suite
 *   node tools/smoke-test.mjs --verbose  # also print every console.log
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WWW = path.resolve(HERE, '..', 'app', 'src', 'main', 'assets', 'www');
const verbose = process.argv.includes('--verbose');

const errors = [];
const failures = [];
let checks = 0;

function check(label, condition, detail) {
  checks++;
  if (condition) {
    console.log(`  \x1b[32m✓\x1b[0m ${label}`);
  } else {
    failures.push(label);
    console.log(`  \x1b[31m✗\x1b[0m ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\x1b[36m\x1b[1m▸ ${title}\x1b[0m`);
}

const virtualConsole = new VirtualConsole();
const JSDOM_KNOWN = [
  "HTMLMediaElement", "Not implemented", "Could not parse CSS stylesheet"
];
virtualConsole.on('jsdomError', (e) => {
  const message = `jsdomError: ${e.message}`;
  if (JSDOM_KNOWN.some((known) => message.includes(known))) return; // jsdom has no media engine
  errors.push(message);
});
virtualConsole.on('error', (...args) => errors.push(`console.error: ${args.join(' ')}`));
if (verbose) virtualConsole.on('log', (...args) => console.log('    [log]', ...args));

const html = fs.readFileSync(path.join(WWW, 'index.html'), 'utf8');
const dom = new JSDOM(html, {
  url: 'http://localhost/index.html',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole
});
const { window } = dom;

// jsdom serves no file:// assets: inject the real scripts/styles by hand.
window.eval(fs.readFileSync(path.join(WWW, 'app.js'), 'utf8'));

const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => Array.from(window.document.querySelectorAll(sel));
const click = (nodeOrSelector) => {
  const node = typeof nodeOrSelector === 'string' ? $(nodeOrSelector) : nodeOrSelector;
  if (!node) throw new Error(`cannot click missing node: ${nodeOrSelector}`);
  node.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, cancelable: true }));
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
  return node;
};
const text = (sel) => ($(sel) ? $(sel).textContent.trim() : null);
const activeScreen = () => $$('.main-screen.active').map((n) => n.id);
const tick = () => new Promise((r) => setTimeout(r, 30));

await tick();

section('boot');
check('app script initialised (window.MS)', !!window.MS, 'window.MS missing');
check('home screen is active', activeScreen().includes('home-screen'), activeScreen().join(','));
check('seeded projects rendered', $$('#home-projects .project-card').length >= 2);
check('effects grid rendered', $$('#effect-grid .effect-card').length >= 10);
check('requestAnimationFrame available', typeof window.requestAnimationFrame === 'function');

section('navigation');
click('[data-nav="projects"]');
await tick();
check('projects screen active', activeScreen().includes('projects-screen'));
click('[data-nav="effects"]');
await tick();
check('effects screen active', activeScreen().includes('effects-screen'));
const colorChip = $('[data-effect-category="Color"]');
click(colorChip);
await tick();
check('effect category filter works', $$('#effect-grid .effect-card').length > 0 && $$('#effect-grid .effect-card').length < 12,
  `${$$('#effect-grid .effect-card').length} cards`);
click('[data-nav="profile"]');
await tick();
check('studio screen active', activeScreen().includes('profile-screen'));
click('[data-nav="home"]');
await tick();
check('back on home', activeScreen().includes('home-screen'));

section('project + editor');
const firstProject = $('#home-projects .project-card');
click(firstProject);
await tick();
check('editor opened', !$('#editor-screen').classList.contains('hidden'));
check('workspace hidden behind editor', $('#main-view').classList.contains('hidden'));
check('editor title filled', (text('#editor-title') || '').length > 0, text('#editor-title'));
check('timeline tracks rendered', $$('.track-row').length === 3, `${$$('.track-row').length} rows`);
check('clips rendered', $$('.clip-block').length > 0, `${$$('.clip-block').length} clips`);
check('ruler ticks rendered', $$('.ruler-tick').length > 2);

section('timeline interactions');
const clipCountBefore = $$('.clip-block').length;
click($$('.clip-block')[0]);
await tick();
check('layer selection shows inspector', !$('#clip-inspector').classList.contains('hidden'));
check('inspector has ranges', $$('#clip-inspector input[type="range"]').length > 0);
click('[data-action="duplicate"]');
await tick();
check('duplicate adds a clip', $$('.clip-block').length === clipCountBefore + 1, `${$$('.clip-block').length} clips`);
// the duplicate becomes the selection; park the playhead inside it and split
const clone = window.MS.state.project.layers[window.MS.state.project.layers.length - 1];
check('duplicate selects the new clip', window.MS.state.selectedLayerId === clone.id);
window.MS.state.time = clone.start + 0.4;
click('[data-action="split"]');
await tick();
check('split adds another clip', $$('.clip-block').length === clipCountBefore + 2, `${$$('.clip-block').length} clips`);
click('[data-action="delete-clip"]');
await tick();
check('delete removes one clip', $$('.clip-block').length === clipCountBefore + 1, `${$$('.clip-block').length} clips`);
click('[data-action="undo"]');
await tick();
check('undo restores the clip', $$('.clip-block').length === clipCountBefore + 2, `${$$('.clip-block').length} clips`);
click('[data-action="redo"]');
await tick();
check('redo removes it again', $$('.clip-block').length === clipCountBefore + 1, `${$$('.clip-block').length} clips`);

section('playback + playhead');
click('[data-action="toggle-play"]');
await tick();
check('playback started', window.MS.state.playing === true);
await new Promise((r) => setTimeout(r, 260));
check('playhead advanced', window.MS.state.time > 0.1, `t=${window.MS.state.time.toFixed(2)}`);
click('[data-action="toggle-play"]');
check('playback paused', window.MS.state.playing === false);
click('[data-action="jump-end"]');
await tick();
check('jump to end positions the playhead at the tail', window.MS.state.time > window.MS.state.project.duration - 0.5,
  `t=${window.MS.state.time.toFixed(2)} of ${window.MS.state.project.duration}`);
click('[data-action="jump-start"]');
check('jump to start resets time', window.MS.state.time === 0);
click('[data-action="zoom-timeline"]');
await tick();
check('zoom changes the px-per-second scale', window.MS.state.zoom > 1, `zoom=${window.MS.state.zoom}`);
click('[data-action="toggle-fit"]');
await tick();
check('canvas mode cycles (fit → fill)', $('#preview-stage').style.objectFit === 'cover', $('#preview-stage').style.objectFit);
click('[data-action="toggle-fit"]');
await tick();
check('canvas mode cycles to safe guides', $('#preview-stage').classList.contains('show-safe'), $('#preview-stage').className);
click('[data-action="toggle-fit"]');
await tick();
check('canvas mode cycles back to fit', !$('#preview-stage').classList.contains('show-safe'));

section('adding layers through sheets');
window.MS.state.stageMode = 'fit';
click('[data-action="add-text"]');
await tick();
check('text sheet opened', !!$('.sheet') && $$('.sheet .text-area').length === 1);
$('.sheet .text-area').value = 'Smoke test title';
click('.sheet .color-swatch:nth-child(2)');
const clipsBeforeText = $$('.clip-block').length;
click('.sheet .primary-button');
await tick();
check('text layer added', $$('.clip-block').length === clipsBeforeText + 1, `${$$('.clip-block').length} clips`);
check('text layer painted on the canvas', text('#stage-text') === 'Smoke test title', text('#stage-text'));

click('[data-action="add-shape"]');
await tick();
click('.sheet .primary-button');
await tick();
check('shape layer added', !!$('#stage-shape') && !$('#stage-shape').classList.contains('hidden'));

click('[data-action="open-media"][data-kind="video"]');
await tick();
check('media sheet opened', !!$('.sheet'));
check('media sheet offers a file picker', !!$('#media-picker'));
const quickButtons = $$('.sheet .secondary-button');
click(quickButtons[quickButtons.length - 2]); // "Solid colour"
await tick();
check('solid colour quick-add works', window.MS.state.project.layers.some((l) => l.srcKind === 'solid'));

section('effects');
click('[data-action="open-effects"]');
await tick();
check('effects sheet opened', $$('.sheet .media-library-item').length > 3);
click('.sheet .media-library-item');
await tick();
check('effect applied to the selected layer',
  window.MS.state.project.layers.some((l) => l.effect),
  JSON.stringify((window.MS.state.project.layers.find((l) => l.effect) || {}).effect || null));
check('layer name shows the effect', /✧/.test(window.MS.state.project.layers.find((l) => l.effect).name));

section('sheets');
for (const [action, label] of [['export', 'export'], ['open-media', 'media']]) {
  click(`[data-action="${action}"]`);
  await tick();
  check(`${label} sheet opens`, !!$('.sheet'));
  click('.sheet .sheet-close');
  await tick();
  check(`${label} sheet closes`, !$('.sheet'));
}

section('export flow');
click('[data-action="export"]');
await tick();
click('.sheet .primary-button');   // "Start export"
await tick();
check('export progress is visible', $('.sheet .export-progress').classList.contains('active'));
await new Promise((r) => setTimeout(r, 3200));
check('export finished and shows a result card', !!$('.sheet') && /complete/i.test($('.sheet').textContent));
const doneButton = $$('.sheet .primary-button')[0];
click(doneButton);
await tick();
check('export sheet closes', !$('.sheet'));

section('back home + persistence');
click('[data-action="close-editor"]');
await tick();
check('editor closed', $('#editor-screen').classList.contains('hidden'));
check('home visible again', !$('#main-view').classList.contains('hidden'));
const stored = JSON.parse(window.localStorage.getItem('motionstudio.projects.v1') || 'null');
check('projects persisted to localStorage', Array.isArray(stored) && stored.length >= 3, JSON.stringify(stored && stored.length));
check('edited project kept its new layers', stored.some((p) => p.layers.length >= 3));

section('hardware back button');
window.MS.openEditor(window.MS.state.projects[0]);
await tick();
check('back closes the editor first', window.MS.handleBack() === 'editor' && $('#editor-screen').classList.contains('hidden'));
click('[data-nav="effects"]');
await tick();
check('back returns to home from another tab', window.MS.handleBack() === 'screen' && activeScreen().includes('home-screen'));
check('back exits from home', window.MS.handleBack() === 'exit');

section('keyboard shortcuts');
const project = window.MS.state.projects[0];
window.MS.openEditor(project);
await tick();
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
await tick();
check('space starts playback', window.MS.state.playing === true);
window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
check('space pauses again', window.MS.state.playing === false);

section('runtime errors');
check('no uncaught page errors', errors.length === 0, errors.slice(0, 4).join(' | '));

console.log(`\n${failures.length ? '\x1b[31m' : '\x1b[32m'}${checks - failures.length}/${checks} checks passed\x1b[0m`);
if (failures.length) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
console.log('UI smoke test passed.\n');
