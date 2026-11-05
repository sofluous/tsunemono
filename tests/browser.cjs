// Run with an installed Playwright package: PLAYWRIGHT_PATH may point to its folder.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const server = http.createServer((req, res) => {
    const file = req.url === '/' ? 'index.html' : req.url.slice(1);
    if (!['index.html', 'styles/console.css', 'styles/skins.css', 'assets/pcb.svg', 'assets/fonts/Silkscreen-Regular.ttf', 'assets/fonts/Silkscreen-Bold.ttf'].includes(file)) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : file.endsWith('.ttf') ? 'font/ttf' : file.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
    res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ hasTouch: true });
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    const skins = ['classic', 'pocket', 'studio', 'candy', 'alloy', 'rugged', 'prism'];
    async function chooseSkin(targetPage, skin) {
      for (let step = 0; step < skins.length; step++) {
        if (await targetPage.locator('html').getAttribute('data-skin') === skin) return;
        await targetPage.getByRole('button', { name: 'Next theme', exact: true }).click();
      }
      assert.equal(await targetPage.locator('html').getAttribute('data-skin'), skin);
    }
    await page.goto(url);
    await chooseSkin(page, 'classic');
    await page.getByRole('button', { name: 'Previous theme', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-skin'), 'prism');
    await page.getByRole('button', { name: 'Next theme', exact: true }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('html').getAttribute('data-skin'), 'classic');
    async function checkScreenMenu(selector, action) {
      const bounds = await page.evaluate(({ selector, action }) => {
        const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; };
        return { stage: rect('#stage'), menu: rect(selector), action: rect(action), parent: document.querySelector(selector).parentElement.id };
      }, { selector, action });
      assert.equal(bounds.parent, 'stage');
      for (const r of [bounds.menu, bounds.action]) {
        assert.ok(r.x >= bounds.stage.x && r.y >= bounds.stage.y && r.right <= bounds.stage.right + 1 && r.bottom <= bounds.stage.bottom + 1, `menu outside screen: ${JSON.stringify(bounds)}`);
      }
    }
    const sizes = [[320, 568], [390, 844], [600, 900], [568, 320], [844, 390], [1024, 768], [1440, 900]];
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      await page.goto(url);
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await page.evaluate(() => document.fonts.check('12px Silkscreen') && [...document.fonts].every(f => f.status === 'loaded')));
      await checkScreenMenu('#startOverlay', '#startBtn');
      await page.locator('#startBtn').click();
      const materials = new Set();
      for (const skin of skins) {
        await chooseSkin(page, skin);
        const geometry = await page.evaluate(() => {
          const rect = s => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
          return { stage: rect('#stage'), pad: rect('.pad'), a: rect('.aBtn'), b: rect('.bBtn'),
            select: rect('[data-k="Select"]'), start: rect('#pauseBtn'), left: rect('.leftControls'), right: rect('.rightControls'), themeControls: rect('.themeControls'),
            leftFrame: rect('.leftControls .clusterBody'), rightFrame: rect('.rightControls .clusterBody'),
            footer: rect('.consoleFooter'), overflow: document.documentElement.scrollWidth > innerWidth,
            canvas: rect('canvas'), skin: document.documentElement.dataset.skin };
        });
        assert.equal(geometry.skin, skin);
        materials.add(await page.locator('#console').evaluate(el => {
          const s = getComputedStyle(el); return [s.backgroundImage, s.borderRadius, s.boxShadow].join('|');
        }));
        assert.equal(geometry.overflow, false, `horizontal overflow ${width} ${skin}`);
        for (const r of [geometry.stage, geometry.pad, geometry.a, geometry.b, geometry.footer, geometry.select, geometry.start]) {
          assert.ok(r.x >= 0 && r.right <= width + 1 && r.y >= 0 && r.bottom <= height + 1, `bounds ${width}x${height}: ${JSON.stringify(r)}`);
        }
        assert.ok(Math.abs(geometry.canvas.width / geometry.canvas.height - 16 / 9) < 0.02);
        assert.ok(geometry.a.width >= 44 && geometry.b.width >= 44);
        assert.ok(geometry.select.width >= 80 && geometry.select.height >= 44);
        assert.ok(geometry.start.width >= 80 && geometry.start.height >= 44);
        assert.ok(geometry.select.bottom + 12 <= geometry.pad.y);
        assert.ok(geometry.start.bottom + 12 <= Math.min(geometry.a.y, geometry.b.y));
        assert.ok(geometry.select.bottom + 28 <= geometry.leftFrame.y, 'Select must be above the decorated grip, not inside it');
        assert.ok(geometry.start.bottom + 28 <= geometry.rightFrame.y, 'Start must be above the decorated grip, not inside it');
        const decor = await page.evaluate(() => ({
          safe: [...document.querySelectorAll('.gripHardware, .edgeHardware, .internals')].every(el => getComputedStyle(el).pointerEvents === 'none' && el.getAttribute('aria-hidden') === 'true'),
          insetShadow: getComputedStyle(document.querySelector('#stage'), '::before').boxShadow,
          boardVisible: getComputedStyle(document.querySelector('.internals')).display !== 'none',
        }));
        assert.equal(decor.safe, true);
        assert.ok(decor.insetShadow.includes('inset'));
        assert.equal(decor.boardVisible, ['pocket', 'prism', 'candy'].includes(skin));
        assert.equal(await page.locator('.clusterBody .grille').count(), 0);
        assert.ok(await page.evaluate(() => {
          const hardware = document.querySelector('.edgeHardware');
          const shell = document.querySelector('#console');
          return hardware.parentElement === shell.parentElement && Number(getComputedStyle(hardware).zIndex) < Number(getComputedStyle(shell).zIndex);
        }), 'external hardware must be a lower sibling layer beneath the console');
        assert.ok(geometry.themeControls.width <= 90);
        assert.equal(await page.locator('.rightControls .screw').count(), 0);
        if (height > width && width <= 760) {
          assert.ok(geometry.select.y - geometry.stage.bottom >= 37);
          assert.ok(Math.abs(geometry.select.y - geometry.start.y) < 1);
          assert.ok(geometry.start.x - geometry.select.right >= 15 && geometry.start.x - geometry.select.right <= 17);
        }
        else {
          // Includes the widest 14px bezel and grip frames extending 4px outward.
          assert.ok(geometry.stage.x - geometry.left.right >= 27);
          assert.ok(geometry.right.x - geometry.stage.right >= 27);
        }
        await page.locator('#pauseBtn').click();
        await checkScreenMenu('#pauseOverlay', '#continueBtn');
        await page.locator('.help summary').click();
        assert.equal(await page.locator('.help').getAttribute('open'), '');
        await checkScreenMenu('#pauseOverlay', '#continueBtn');
        const scrollable = await page.locator('.help').evaluate(el => {
          el.scrollTop = el.scrollHeight;
          return el.scrollHeight <= el.clientHeight || el.scrollTop > 0;
        });
        assert.ok(scrollable, 'expanded help must remain scrollable inside screen');
        await page.keyboard.press('Escape');
        assert.equal(await page.locator('#pauseOverlay').isVisible(), false);
        await page.evaluate(() => document.querySelector('.help').open = false);
      }
      assert.equal(materials.size, skins.length);
      console.log(`PASS layout, local font, screen menus ${width}x${height}, all seven material skins`);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    assert.equal(await page.locator('html').getAttribute('data-skin'), 'prism');
    await page.locator('#startBtn').click();
    // A skin change must preserve the live canvas node, its contents, and pad geometry.
    await page.locator('#pauseBtn').click();
    await page.waitForTimeout(80);
    const before = await page.evaluate(() => {
      window.originalCanvas = document.querySelector('canvas');
      return { image: originalCanvas.toDataURL(), pad: document.querySelector('.pad').getBoundingClientRect().toJSON() };
    });
    await chooseSkin(page, 'pocket');
    const after = await page.evaluate(() => ({ same: originalCanvas === document.querySelector('canvas'), image: originalCanvas.toDataURL(), pad: document.querySelector('.pad').getBoundingClientRect().toJSON() }));
    assert.equal(after.same, true); assert.equal(after.image, before.image); assert.deepEqual(after.pad, before.pad);
    await page.locator('#continueBtn').click();
    // Real browser pointer capture: a single mouse drag changes direction then releases outside.
    const pad = await page.locator('.pad').boundingBox();
    await page.mouse.move(pad.x + pad.width / 2, pad.y + 8);
    await page.mouse.down();
    assert.ok(await page.locator('.upBtn').evaluate(el => el.classList.contains('is-held')));
    await page.mouse.move(pad.x + pad.width - 8, pad.y + pad.height / 2);
    assert.ok(await page.locator('.rightBtn').evaluate(el => el.classList.contains('is-held')));
    assert.equal(await page.locator('.upBtn').evaluate(el => el.classList.contains('is-held')), false);
    await page.mouse.move(pad.x + pad.width + 30, pad.y + pad.height / 2);
    await page.mouse.up();
    assert.equal(await page.locator('.is-held').count(), 0);
    const cdp = await context.newCDPSession(page);
    const touch = (id, x, y) => ({ id, x, y, radiusX: 6, radiusY: 6, force: 1 });
    const up = touch(1, pad.x + pad.width / 2, pad.y + 8);
    const right = touch(1, pad.x + pad.width - 8, pad.y + pad.height / 2);
    const action = await page.locator('.aBtn').boundingBox();
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [up] });
    assert.ok(await page.locator('.upBtn').evaluate(el => el.classList.contains('is-held')));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [right] });
    assert.ok(await page.locator('.rightBtn').evaluate(el => el.classList.contains('is-held')));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [right, touch(2, action.x + action.width / 2, action.y + action.height / 2)] });
    assert.ok(await page.locator('.rightBtn').evaluate(el => el.classList.contains('is-held')));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.equal(await page.locator('.is-held').count(), 0);
    // Native focused button activation and select keyboard interaction remain available.
    await page.locator('.upBtn').focus();
    await page.keyboard.down('Space');
    assert.ok(await page.locator('.upBtn').evaluate(el => el.classList.contains('is-held')));
    await page.keyboard.up('Space');
    assert.equal(await page.locator('.is-held').count(), 0);
    await page.locator('#pauseBtn').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#pauseOverlay').isVisible(), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#pauseOverlay').isVisible(), false);
    await page.locator('#pauseBtn').click();
    await page.locator('#pauseBtn').click();
    assert.equal(await page.locator('#pauseOverlay').isVisible(), false);
    if (process.env.ARTIFACT_DIR) {
      fs.mkdirSync(process.env.ARTIFACT_DIR, { recursive: true });
      for (const skin of skins) {
        await chooseSkin(page, skin);
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${skin}-portrait.png`) });
        await page.setViewportSize({ width: 844, height: 390 });
        await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, `${skin}-landscape.png`) });
        await page.setViewportSize({ width: 390, height: 844 });
      }
      await chooseSkin(page, 'classic');
      await page.locator('#pauseBtn').click();
      await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, 'classic-pause.png') });
      await page.locator('.help summary').click();
      await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, 'classic-help.png') });
      await page.keyboard.press('Escape');
      await page.setViewportSize({ width: 320, height: 568 });
      await page.reload();
      await page.screenshot({ path: path.join(process.env.ARTIFACT_DIR, 'classic-start-narrow.png') });
    }
    assert.deepEqual(errors, []);
    const restricted = await browser.newContext();
    await restricted.addInitScript(() => Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage denied'); } }));
    const restrictedPage = await restricted.newPage();
    restrictedPage.on('pageerror', e => errors.push(e.message));
    await restrictedPage.goto(url);
    await chooseSkin(restrictedPage, 'studio');
    assert.equal(await restrictedPage.locator('html').getAttribute('data-skin'), 'studio');
    await restrictedPage.locator('#startBtn').click();
    assert.deepEqual(errors, []);
    await restricted.close();
    console.log('PASS persistence, denied storage, state preservation, mouse/touch drag, simultaneous A, keyboard controls; no page errors');
    await context.close();
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
