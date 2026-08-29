import puppeteer from 'puppeteer-core';

const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const client = process.env.CLIENT_URL || 'http://localhost:5173';
const shotDirectory = process.env.SHOT_DIR || 'tools/.smoke';
const browser = await puppeteer.launch({
  executablePath: chrome,
  headless: 'new',
  args: ['--no-sandbox', '--ignore-gpu-blocklist', '--enable-webgl', '--use-gl=angle',
    '--use-angle=swiftshader', '--enable-unsafe-swapchain', '--window-size=1280,800'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
const pageErrors = [];
const consoleErrors = [];
let postedVenue = null;
let postedTimings = null;
page.on('pageerror', error => pageErrors.push(String(error)));
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
await page.setRequestInterception(true);
page.on('request', request => {
  if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/karaoke-venue') {
    postedVenue = JSON.parse(request.postData() || '{}');
    void request.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(postedVenue) });
  } else if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/karaoke-timings') {
    postedTimings = JSON.parse(request.postData() || '{}');
    void request.respond({
      status: 200,
      contentType: 'application/json',
      headers: { ETag: '"karaoke-timings-smoke"' },
      body: JSON.stringify(postedTimings),
    });
  } else void request.continue();
});

try {
  await page.goto(`${client}/editor?game=karaoke`, { waitUntil: 'networkidle2', timeout: 45_000 });
  await page.waitForFunction(() => document.querySelector('#kvStatus')?.textContent === 'Venue loaded', { timeout: 45_000 });
  await page.click('[data-tree-role="lead-singer"]');
  await page.$eval('#kv-pos-x', input => {
    input.value = '-2.75';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.click('#kvSetCamera');
  const beforeSave = await page.evaluate(() => window.__karaokeVenueEditor?.snapshot());
  const fallbackRoles = await page.$$eval('#kvTree [data-tree-role]', buttons => buttons
    .filter(button => button.textContent?.includes('procedural fallback'))
    .map(button => button.getAttribute('data-tree-role')));
  await page.click('#kvSave');
  await page.waitForFunction(() => document.querySelector('#kvStatus')?.textContent === 'Venue saved', { timeout: 10_000 });
  await (await import('node:fs/promises')).mkdir(shotDirectory, { recursive: true });
  await page.screenshot({ path: `${shotDirectory}/karaoke-venue-editor.png` });
  const lead = beforeSave?.models.find(model => model.role === 'lead-singer');
  const camera = beforeSave?.cameras.landscape;
  const venueOk = lead?.transform.position[0] === -2.75
    && Array.isArray(camera?.position) && camera.position.length === 3
    && postedVenue?.models?.find(model => model.role === 'lead-singer')?.transform?.position?.[0] === -2.75
    && fallbackRoles.length === 0;

  await page.goto(`${client}/editor?game=karaoke&tool=timing`, { waitUntil: 'networkidle2', timeout: 45_000 });
  await page.waitForFunction(() => document.querySelector('#ktStatus')?.textContent === 'Timings loaded', { timeout: 45_000 });
  await page.select('#ktSong', 'a-thousand-miles');
  await page.click('#ktPlay');
  await page.waitForFunction(() => document.querySelector('#ktPlay')?.textContent === 'Pause', { timeout: 10_000 });
  await new Promise(resolve => setTimeout(resolve, 180));
  const playbackAdvanced = await page.$eval('#ktTime', output => output.textContent !== '00:00.000');
  await page.click('#ktPlay');
  await page.$eval('#ktScrub', input => {
    input.value = '7000';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const scrubbedTime = await page.$eval('#ktTime', output => output.textContent);
  const drag = async (selector, deltaX) => {
    const element = await page.$(selector);
    await element?.evaluate(node => node.scrollIntoView({ block: 'center', inline: 'center' }));
    const box = await element?.boundingBox();
    if (!box) throw new Error(`missing drag target: ${selector}`);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + deltaX, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
  };
  const beforeIndividual = await page.evaluate(() => window.__karaokeTimingEditor?.wordsSnapshot());
  await drag('[data-word-id="a-thousand-miles-01-01"] .handle.start', 8);
  await drag('[data-word-id="a-thousand-miles-03-06"] .handle.end', 8);
  await drag('[data-word-id="a-thousand-miles-01-02"] em', 8);
  const afterIndividual = await page.evaluate(() => window.__karaokeTimingEditor?.wordsSnapshot());
  const marquee = await page.evaluate(() => {
    const viewport = document.querySelector('#ktTimelineViewport');
    const timeline = document.querySelector('#ktTimeline');
    const first = document.querySelector('[data-word-id="a-thousand-miles-04-01"]');
    const last = document.querySelector('[data-word-id="a-thousand-miles-05-04"]');
    viewport.scrollLeft = Math.max(0, first.offsetLeft - 180);
    const bounds = timeline.getBoundingClientRect();
    return {
      startX: bounds.left + first.offsetLeft - 2,
      endX: bounds.left + last.offsetLeft + last.offsetWidth + 2,
      y: bounds.top + 16,
    };
  });
  await page.mouse.move(marquee.startX, marquee.y);
  await page.mouse.down();
  await page.mouse.move(marquee.endX, marquee.y, { steps: 8 });
  await page.mouse.up();
  const multiSelectedCount = await page.$$eval('.word.selected', words => words.length);
  const beforeGroup = await page.evaluate(() => window.__karaokeTimingEditor?.wordsSnapshot());
  await drag('[data-word-id="a-thousand-miles-04-01"] em', -8);
  const afterGroup = await page.evaluate(() => window.__karaokeTimingEditor?.wordsSnapshot());
  const timingSnapshot = await page.evaluate(() => window.__karaokeTimingEditor?.snapshot());
  await page.click('#ktSave');
  await page.waitForFunction(() => document.querySelector('#ktStatus')?.textContent?.startsWith('Timings saved'), { timeout: 10_000 });
  await page.screenshot({ path: `${shotDirectory}/karaoke-timing-editor.png` });
  const thousandOverrides = timingSnapshot?.songs.find(song => song.songId === 'a-thousand-miles')?.words ?? [];
  const editedIds = new Set(thousandOverrides.map(word => word.wordId));
  const groupDelta = wordId => (afterGroup?.find(word => word.id === wordId)?.startMs ?? 0)
    - (beforeGroup?.find(word => word.id === wordId)?.startMs ?? 0);
  const firstGroupDelta = groupDelta('a-thousand-miles-04-01');
  const groupMovedTogether = firstGroupDelta !== 0
    && firstGroupDelta === groupDelta('a-thousand-miles-05-04');
  const individualDelta = (wordId, field) => (afterIndividual?.find(word => word.id === wordId)?.[field] ?? 0)
    - (beforeIndividual?.find(word => word.id === wordId)?.[field] ?? 0);
  const bodyStartDelta = individualDelta('a-thousand-miles-01-02', 'startMs');
  const individualMoved = individualDelta('a-thousand-miles-01-01', 'startMs') !== 0
    && individualDelta('a-thousand-miles-03-06', 'endMs') !== 0
    && bodyStartDelta !== 0
    && bodyStartDelta === individualDelta('a-thousand-miles-01-02', 'endMs');
  const timingOk = individualMoved
    && playbackAdvanced
    && scrubbedTime === '00:07.000'
    && multiSelectedCount === 8
    && groupMovedTogether
    && postedTimings?.songs?.some(song => song.songId === 'a-thousand-miles');

  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: `${shotDirectory}/karaoke-timing-editor-mobile.png` });
  const mobileLayout = await page.evaluate(() => {
    const viewport = document.querySelector('#ktTimelineViewport')?.getBoundingClientRect();
    const inspector = document.querySelector('#ktInspector')?.getBoundingClientRect();
    const bounds = rect => rect && ({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    return { viewport: bounds(viewport), inspector: bounds(inspector), width: innerWidth, height: innerHeight };
  });
  const mobileOk = mobileLayout.viewport && mobileLayout.inspector
    && mobileLayout.viewport.left >= 0 && mobileLayout.viewport.right <= mobileLayout.width
    && mobileLayout.inspector.left >= 0 && mobileLayout.inspector.right <= mobileLayout.width
    && mobileLayout.inspector.bottom <= mobileLayout.height;
  const ok = venueOk && timingOk && mobileOk && pageErrors.length === 0;
  console.log(JSON.stringify({
    result: ok ? 'PASS' : 'FAIL',
    selectedRole: lead?.role,
    transformedX: lead?.transform.position[0],
    camera,
    saveIntercepted: postedVenue !== null,
    fallbackRoles,
    timingEditedWordIds: [...editedIds],
    timingSaveIntercepted: postedTimings !== null,
    multiSelectedCount,
    individualMoved,
    groupMovedTogether,
    playbackAdvanced,
    scrubbedTime,
    mobileLayout,
    consoleErrors,
    pageErrors,
  }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await browser.close();
}
