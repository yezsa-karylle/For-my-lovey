const { _electron } = require('playwright-core');
const path = require('path');
(async () => {
  const app = await _electron.launch({ args: [path.join(__dirname, '../..'), '--no-sandbox'], env: { ...process.env, REDRAFT_MAXIMIZE: '0' } });
  const win = await app.firstWindow();
  const logs = [];
  win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  win.on('pageerror', (e) => logs.push('[pageerror] ' + e.message));
  await win.setViewportSize({ width: 1400, height: 880 }).catch(() => {});
  await win.waitForFunction(() => window.__ready === true, null, { timeout: 15000 }).catch((e) => logs.push('not ready: ' + e.message));
  await win.screenshot({ path: path.join(__dirname, 'out/smoke-welcome.png') });
  console.log(logs.join('\n'));
  await app.close();
})().catch((e) => { console.error(e); process.exit(1); });
