import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, statfs, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowRehearsalSocket, createRequestGuard, parseInvocation, relayWithoutRedirects, validateCheckout, validateDeployment } from './guest-canary-guards.mjs';

// No network or third-party module loading until all approval/source gates pass.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const { live, origin, receiptPath } = parseInvocation(process.argv.slice(2));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const sourceCheckoutSha = git(['rev-parse', 'HEAD']);
const receiptBytes = live ? await readFile(receiptPath) : null;
const deployment = live ? validateDeployment(JSON.parse(receiptBytes.toString('utf8'))) : null;
const releaseSha = deployment?.releaseSha ?? sourceCheckoutSha;
let releaseIsAncestor = false;
try {
  git(['merge-base', '--is-ancestor', releaseSha, sourceCheckoutSha]);
  releaseIsAncestor = true;
} catch { /* Fail closed on missing or unrelated release commits. */ }
validateCheckout({ sourceCheckoutSha, status: git(['status', '--porcelain']), releaseIsAncestor });
const { chromium, expect } = await import('@playwright/test');
const { default: JSZip } = await import('jszip');
const disk = await statfs(root);
assert(disk.bavail * disk.bsize > 256 * 1024 * 1024, 'Canary needs at least 256 MiB free for artifacts.');
const parent = join(root, 'work', 'canary-artifacts');
await mkdir(parent, { recursive: true });
const artifacts = await mkdtemp(join(parent, live ? 'live-' : 'rehearsal-'));
const report = {
  releaseSha, sourceCheckoutSha, mode: live ? 'live' : 'local-rehearsal', origin, deployment,
  harnessSha256: createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex'),
  guardsSha256: createHash('sha256').update(await readFile(new URL('./guest-canary-guards.mjs', import.meta.url))).digest('hex'),
  deploymentReceiptSha256: receiptBytes ? createHash('sha256').update(receiptBytes).digest('hex') : null,
  versionEvidence: live ? 'Platform-supplied deployment receipt; local Git HEAD does not attest the live Worker version.' : 'Local rehearsal only; not deployment or live-auth evidence.',
  startedAt: new Date().toISOString(), status: 'running', artifacts,
  rehearsalAuthMocked: !live,
  rehearsalLocalNetworkPermission: !live,
  scope: 'Guest-only canary; no account creation, login, logout, deploy, migration, merge, or intentional account/project writes.',
  incidentalLiveWrites: 'Normal anonymous session GET can update D1 limiter buckets and delete up to 100 expired limiter rows.',
  checks: [], downloads: [], responses: [], requests: [], violations: [], pageErrors: [], consoleErrors: [], requestFailures: [],
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const saveReport = () => writeFile(join(artifacts, 'receipt.json'), JSON.stringify(report, null, 2) + '\n');
async function check(name, action) {
  const start = Date.now();
  try {
    const details = await action();
    report.checks.push({ name, status: 'passed', elapsedMs: Date.now() - start, details });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.checks.push({ name, status: 'failed', elapsedMs: Date.now() - start, error: String(error).slice(0,3000) });
    throw error;
  } finally { await saveReport(); }
}
function pngInfo(bytes) {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const info = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), physical: [] };
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    assert(offset + length + 12 <= bytes.length);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'pHYs') info.physical.push([bytes.readUInt32BE(offset+8), bytes.readUInt32BE(offset+12), bytes[offset+16]]);
    offset += length + 12;
    if (type === 'IEND') break;
  }
  assert.equal(info.width, 1920); assert.equal(info.height, 2400);
  assert.deepEqual(info.physical, [[9449, 9449, 1]]);
  return info;
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true, serviceWorkers: 'block' });
context.setDefaultTimeout(15000);
context.setDefaultNavigationTimeout(30000);
await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
const guard = createRequestGuard({ live });
await context.route('**/*', async route => {
  const req = route.request();
  const decision = guard.inspect({ url: req.url(), method: req.method(), redirected: Boolean(req.redirectedFrom()) });
  const { allowed, session, ...request } = decision;
  report.requests.push(request);
  if (!allowed) {
    report.violations.push({ ...request, reason: 'Origin, method, API, redirect or session budget rejected' });
    return route.abort('blockedbyclient');
  }
  if (!live && session) return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: 'null' });
  // Never follow HTTP redirects, including during a loopback rehearsal.
  return relayWithoutRedirects(route, {
    onRedirect: status => report.violations.push({ ...request, reason: 'Redirect rejected before following', status }),
    onFailure: error => report.requestFailures.push({ ...request, error: String(error).slice(0, 1000) }),
  });
});
await context.routeWebSocket('**/*', socket => {
  if (allowRehearsalSocket(live, socket.url())) {
    socket.connectToServer();
    return;
  }
  const url = new URL(socket.url());
  report.violations.push({ method: 'WEBSOCKET', origin: url.origin, path: url.pathname });
  socket.close();
});
const page = await context.newPage();
page.on('pageerror', error => report.pageErrors.push(error.message));
page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
page.on('requestfailed', request => {
  const url = new URL(request.url());
  if (['http:', 'https:'].includes(url.protocol)) report.requestFailures.push({ method: request.method(), origin: url.origin, path: url.pathname, error: request.failure()?.errorText });
});
page.on('response', response => {
  const url = new URL(response.url());
  const headers = response.headers();
  const safeHeaders = Object.fromEntries(['content-type','cache-control','cf-ray','cf-cache-status','cf-mitigated','x-content-type-options'].filter(name=>headers[name]!==undefined).map(name=>[name,headers[name]]));
  if (['http:', 'https:'].includes(url.protocol)) report.responses.push({ method: response.request().method(), origin: url.origin, path: url.pathname, status: response.status(), type: response.request().resourceType(), headers:safeHeaders });
});
const canvas = page.getByTestId('artwork-canvas');
async function canvasHash() {
  return canvas.evaluate(async element => {
    const data = element.getContext('2d').getImageData(0, 0, element.width, element.height).data;
    const hash = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hash), x => x.toString(16).padStart(2, '0')).join('');
  });
}
async function settledCanvasHash() {
  let last = ''; let count = 0;
  await expect.poll(async () => {
    const next = await canvasHash(); count = next === last ? count + 1 : 0; last = next;
    return count >= 3;
  }, { timeout: 15000, intervals: [100] }).toBe(true);
  return last;
}
async function decodedArtwork(bytes, type) {
  const result = await page.evaluate(async data => {
    const image = new Image(); image.src = data; await image.decode();
    const c = document.createElement('canvas'); c.width=400;c.height=500;
    const ctx=c.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,400,500);ctx.drawImage(image,0,0,400,500);
    const pixels=ctx.getImageData(150,190,100,120).data;
    let ink=0;for(let i=0;i<pixels.length;i+=4) if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<230) ink++;
    return {width:image.width,height:image.height,centralInkPixels:ink};
  }, `data:${type};base64,${bytes.toString('base64')}`);
  assert(result.centralInkPixels>20, 'Export must contain artwork away from registration marks');
  return result;
}
async function numeric(id, value) {
  const field = page.getByTestId(`numeric-${id}`);
  await field.fill(String(value)); await field.press('Enter'); await expect(field).toHaveValue(String(value));
}
async function screenshot(name) { await page.screenshot({ path: join(artifacts, name), fullPage: true }); }
async function download(label, prefix) {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const waiting = page.waitForEvent('download', { timeout: 90000 });
  await page.getByRole('button', { name: new RegExp(label) }).click();
  const item = await waiting;
  const filename = item.suggestedFilename();
  assert.equal(filename, basename(filename)); assert(filename.startsWith('canary'));
  const path = join(artifacts, `${prefix}-${filename}`);
  assert.equal(await item.failure(), null);
  const temporaryPath = await item.path(); assert(temporaryPath, 'Downloaded bytes are required.');
  const bytes = await readFile(temporaryPath);
  await writeFile(path, bytes, { flag: 'wx' });
  report.downloads.push({ filename, artifact: basename(path), bytes: bytes.length, sha256: sha256(bytes) });
  return bytes;
}
async function packageInfo(bytes, extension, plates, diffusion = false) {
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  const entries = Object.keys(zip.files).filter(name => !zip.files[name].dir);
  const files = entries.filter(name => name.endsWith(extension));
  assert.equal(files.length, plates.length);
  const jobFile = entries.find(name => name.endsWith('job-settings.json')); assert(jobFile);
  const job = JSON.parse(await zip.file(jobFile).async('string'));
  assert.equal(job.output.width, 1920); assert.equal(job.output.height, 2400); assert.equal(job.output.dpi, 240);
  assert.equal(job.source, 'canary.png'); assert.equal(job.document.sheetSize, '8x10');
  assert.equal(Boolean(job.settings.diffusionEnabled), diffusion);
  assert.equal(job.settings.dotShape, 'custom'); assert.equal(job.settings.customShape.filename, 'canary-ring.svg');
  assert.match(job.settings.customShape.svg, /fill-rule="evenodd"/);
  assert.equal(job.registration, true); assert.equal(job.registrationShape.filename, 'canary-registration.svg');
  for (const plate of plates) {
    const name = files.find(name => extension === '.svg' ? name.endsWith(`/${plate}.svg`) : name.endsWith(`-${plate}-plate.png`));
    assert(name, `Missing ${plate} plate`);
    if (extension === '.png') {
      const png = await zip.file(name).async('nodebuffer'); pngInfo(png); await decodedArtwork(png,'image/png');
    }
    else {
      const svg = await zip.file(name).async('string');
      assert(svg.includes('viewBox="0 0 1920 2400"')); assert.match(svg, /<circle|<rect|<path/);
      if (!diffusion && plate === plates[0]) await decodedArtwork(Buffer.from(svg),'image/svg+xml');
    }
  }
  return { entries, output: job.output, diffusion: Boolean(job.settings.diffusionEnabled), customDot: job.settings.customShape?.filename, registration: job.registrationShape.filename };
}
try {
  // Intercepted local pages need this origin-scoped Chromium permission for HMR.
  // Request/socket guards still restrict traffic to the fixed rehearsal server.
  if (!live) await context.grantPermissions(['local-network-access'], { origin });
  await check('health endpoint', async () => {
    const response = await context.request.get(`${origin}/api/health`, { maxRedirects: 0, maxRetries: 0, timeout: 30000 });
    assert.equal(response.status(), 200); assert.deepEqual(await response.json(), { ok: true });
    return { status: response.status() };
  });
  await check(live ? 'real anonymous session and studio boot' : 'studio boot with rehearsal-only anonymous-session mock', async () => {
    assert.deepEqual(await context.cookies(), []);
    const sessionResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/get-session').catch(()=>null);
    const response = await page.goto(`${origin}/`); assert.equal(response.status(), 200);
    const session = await sessionResponse;
    assert(session, 'Studio did not receive an anonymous-session response within the canary timeout');
    assert.equal(session.status(), 200); assert.equal(await session.json(), null);
    assert.match(session.headers()['cache-control'], /no-store/); assert.equal(session.headers()['x-content-type-options'], 'nosniff');
    await expect(canvas).toBeVisible();
    await expect(page.getByTestId('session-badge')).toContainText('Guest proof');
    await expect(page.getByTestId('session-badge-action')).toHaveText('Sign in');
    const dimensions = await canvas.evaluate(c => ({ width: c.width, height: c.height }));
    assert(dimensions.width > 0 && dimensions.height > 0);
    await expect.poll(() => canvas.evaluate(c => {
      const data = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      for (let i=4;i<data.length;i+=4) if(data[i]!==data[0] || data[i+1]!==data[1] || data[i+2]!==data[2]) return true;
      return false;
    })).toBe(true);
    await screenshot('01-studio-boot.png');
    return { sessionStatus: 200, noStore: true, nosniff: true, mocked: !live, dimensions };
  });
  await check('all five stages remain reachable', async () => {
    for (const id of ['artwork', 'halftone-cmyk', 'diffusion', 'glitch', 'output']) {
      await page.getByTestId(`stage-${id}`).click();
      await expect(page.getByTestId(`stage-${id}`)).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByTestId(`stage-panel-${id}`)).toBeVisible();
    }
  });
  await check('synthetic PNG JPEG WebP import; invalid signature preserves artwork', async () => {
    await page.getByTestId('stage-artwork').click();
    const images = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 480; c.height = 600;
      const ctx = c.getContext('2d');
      for (let y = 0; y < 600; y += 20) for (let x = 0; x < 480; x += 20) {
        ctx.fillStyle = `rgb(${x % 256},${y % 256},${(x * 3 + y) % 256})`; ctx.fillRect(x, y, 20, 20);
      }
      return ['image/jpeg', 'image/webp', 'image/png'].map(type => c.toDataURL(type).split(',')[1]);
    });
    const input = page.locator('input[type="file"][accept="image/png,image/jpeg,image/webp"]');
    for (const [i, extension, mimeType] of [[0, 'jpg', 'image/jpeg'], [1, 'webp', 'image/webp'], [2, 'png', 'image/png']]) {
      const bytes = Buffer.from(images[i], 'base64');
      await writeFile(join(artifacts, `input-canary.${extension}`), bytes, { flag: 'wx' });
      await input.setInputFiles({ name: `canary.${extension}`, mimeType, buffer: bytes });
      await expect(page.locator('.upload-card strong')).toHaveText(`canary.${extension}`);
      await expect(page.getByRole('status')).toContainText('Artwork loaded');
    }
    await input.setInputFiles({ name: 'invalid.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('GIF89a') });
    await expect(page.getByRole('status')).toContainText('does not contain');
    await expect(page.locator('.upload-card strong')).toHaveText('canary.png');
    await page.getByTestId('artwork-sheet-size').selectOption('8x10');
    await page.getByTestId('artwork-orientation-portrait').click();
    await page.getByTestId('artwork-fit').click();
  });
  await check('CMYK angle entry, keyboard solo/visibility and rendered control effect', async () => {
    await page.getByTestId('stage-halftone-cmyk').click();
    const before = await settledCanvasHash(); await numeric('cellSize', 32);
    await expect.poll(canvasHash).not.toBe(before);
    const angle = page.getByTestId('ink-angle-cyan'); await angle.fill('33'); await angle.press('Enter'); await expect(angle).toHaveValue('33');
    const magenta = page.getByTestId('ink-chip-magenta'); await magenta.focus(); await magenta.press('Enter');
    await expect(magenta).toHaveAttribute('aria-pressed', 'true');
    await magenta.press('Alt+Enter'); await expect(magenta).toHaveAttribute('data-visible', 'false');
    await magenta.press('Alt+Enter'); await expect(magenta).toHaveAttribute('data-visible', 'true');
    await page.getByTestId('ink-chip-composite').click();
    return { before, after: await canvasHash(), cyanAngle: 33 };
  });
  await check('custom SVG confirmation, rejection and independent registration', async () => {
    const ring = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path fill-rule="evenodd" d="M0 0H100V100H0Z M25 25V75H75V25Z"/></svg>';
    await page.getByRole('combobox', { name: 'Dot shape', exact: true }).selectOption('custom');
    await page.getByTestId('custom-shape-file').setInputFiles({ name: 'canary-ring.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(ring) });
    await expect(page.getByRole('button', { name: 'Use shape', exact: true })).toBeEnabled();
    await screenshot('02-custom-svg-dialog.png');
    await page.getByRole('button', { name: 'Use shape', exact: true }).click();
    await expect(page.getByTestId('current-custom-shape')).toHaveText('canary-ring.svg');
    await page.getByRole('button', { name: 'Replace SVG', exact: true }).click();
    await page.getByTestId('custom-shape-file').setInputFiles({ name: 'invalid.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg><text>Not outlined</text></svg>') });
    await expect(page.getByRole('alert')).toContainText('text to paths');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('current-custom-shape')).toHaveText('canary-ring.svg');
    await page.getByTestId('stage-output').click();
    await page.locator('input[type="file"][accept=".svg,image/svg+xml"]').setInputFiles({ name: 'canary-registration.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(ring) });
    await expect(page.getByRole('checkbox', { name: /Registration marks/ })).toBeChecked();
    await expect(page.getByTestId('stage-panel-output').getByText('canary-registration.svg', { exact: true })).toBeVisible();
    await screenshot('03-output-preflight.png');
  });
  await check('composite PNG at 1920x2400 and 240 DPI', async () => {
    const bytes=await download('Composite PNG','04');const info=pngInfo(bytes);return {...info,decoded:await decodedArtwork(bytes,'image/png')};
  });
  await check('composite JPG decodes to document dimensions', async () => {
    const bytes = await download('Composite JPG', '05'); assert.equal(bytes.subarray(0, 2).toString('hex'), 'ffd8');
    const size = await page.evaluate(async data => { const image = new Image(); image.src = data; await image.decode(); return [image.width, image.height]; }, `data:image/jpeg;base64,${bytes.toString('base64')}`);
    assert.deepEqual(size, [1920,2400]); return { size };
  });
  await check('composite RGBA TIFF geometry', async () => {
    const bytes = await download('Composite TIFF', '06'); assert.equal(bytes.subarray(0,4).toString('hex'), '49492a00');
    const ifd = bytes.readUInt32LE(4); const count = bytes.readUInt16LE(ifd); const tags = {};
    for (let i=0;i<count;i++) { const offset=ifd+2+i*12; const tag=bytes.readUInt16LE(offset); const type=bytes.readUInt16LE(offset+2); tags[tag]=type===3 ? bytes.readUInt16LE(offset+8) : bytes.readUInt32LE(offset+8); }
    assert.equal(tags[256],1920); assert.equal(tags[257],2400); assert.equal(tags[277],4);
    assert(bytes.length >= 1920*2400*4); return { width:tags[256],height:tags[257],samples:tags[277] };
  });
  await check('CMYK PNG plate package and job settings', async () => packageInfo(await download('CMYK plate package','07'),'.png',['C','M','Y','K']));
  await check('custom-dot SVG plate package and job settings', async () => packageInfo(await download('Vector SVG plate package','08'),'.svg',['C','M','Y','K']));
  await check('glitch effect changes actual canvas with diffusion off', async () => {
    await page.getByTestId('stage-glitch').click(); const before=await settledCanvasHash();
    await numeric('sliceShift',80); await numeric('gridWarp',40);
    await expect.poll(canvasHash).not.toBe(before); const after=await settledCanvasHash();assert.notEqual(after,before);
    await screenshot('09-glitch-proof.png'); await page.getByRole('button',{name:'Reset Glitch controls',exact:true}).click();
    return { before,after };
  });
  await check('diffusion mode changes actual canvas and preserves SVG export', async () => {
    await page.getByTestId('stage-diffusion').click(); const before=await settledCanvasHash();
    await page.getByRole('checkbox',{name:/Enable diffusion/}).check();
    await page.getByRole('combobox',{name:'Algorithm',exact:true}).selectOption('atkinson');
    await expect.poll(canvasHash).not.toBe(before); await screenshot('10-diffusion-proof.png');
    const result=await packageInfo(await download('Vector SVG plate package','11'),'.svg',['C','M','Y','K'],true);
    await page.getByRole('checkbox',{name:/Enable diffusion/}).uncheck(); return result;
  });
  await check('grayscale K export and retained CMY settings', async () => {
    await page.getByTestId('stage-halftone-cmyk').click();
    await page.getByRole('combobox',{name:'Color mode',exact:true}).selectOption('grayscale');
    const result=await packageInfo(await download('Grayscale K plate package','12'),'.png',['K']);
    await page.getByRole('combobox',{name:'Color mode',exact:true}).selectOption('cmyk');
    await expect(page.getByTestId('ink-angle-cyan')).toHaveValue('33'); return result;
  });
  await check('job-ticket download fallback under denied clipboard permission', async () => {
    await page.getByTestId('stage-output').click();
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{ configurable:true,value:{writeText:async()=>{throw new DOMException('Canary clipboard denial','NotAllowedError');}} }));
    const waiting=page.waitForEvent('download'); await page.getByRole('button',{name:/Copy job ticket/i}).click();
    const item=await waiting; const path=join(artifacts,'13-job-ticket.txt'); assert.equal(await item.failure(),null);
    const temporaryPath=await item.path(); assert(temporaryPath); await writeFile(path,await readFile(temporaryPath),{flag:'wx'});
    const ticket=await readFile(path,'utf8'); assert.match(ticket,/240 DPI/); assert.match(ticket,/1920 × 2400px/); assert.match(ticket,/canary-registration.svg/);
    return { bytes:Buffer.byteLength(ticket),sha256:sha256(ticket),clipboardDeniedIntentionally:true };
  });
  await check('public login and signup surfaces without submission', async () => {
    for (const [path,heading] of [['/login','Sign in'],['/signup','Create an account']]) {
      const response=await page.goto(origin+path); assert.equal(response.status(),200);
      await expect(page.getByRole('heading',{name:heading,exact:true})).toBeVisible();
      await expect(page.getByRole('textbox',{name:'Email',exact:true})).toBeVisible();
      if(path==='/signup') await expect(page.getByLabel('Password',{exact:true})).toHaveAttribute('minlength','12');
      await screenshot(path==='/login'?'14-login.png':'15-signup.png');
    }
  });
  await check('asset/network/runtime guard', async () => {
    assert.deepEqual(report.violations,[]); assert.deepEqual(report.pageErrors,[]); assert.deepEqual(report.consoleErrors,[]);
    assert.deepEqual(report.requestFailures,[]);
    assert(report.responses.every(r=>r.origin===origin));
    assert.deepEqual(report.responses.filter(r=>r.status>=400),[]);
    const scripts=report.responses.filter(r=>r.type==='script'); assert(scripts.length>0);
    if(live) assert(scripts.some(r=>r.path.startsWith('/assets/')));
    return { sessionGets: guard.sessionGets,scriptPaths:scripts.map(r=>r.path) };
  });
  report.status='passed';
} catch(error) {
  report.status='failed'; report.failure=String(error).slice(0,4000); process.exitCode=1;
  await screenshot('failure.png').catch(()=>{});
  console.error(report.failure);
} finally {
  await context.tracing.stop({path:join(artifacts,'trace.zip')}).catch(error=>{report.traceError=String(error);report.status='failed';process.exitCode=1;});
  await browser.close();
  report.finishedAt=new Date().toISOString(); report.sessionGets=guard.sessionGets;
  report.artifactManifest=[];
  for(const name of (await readdir(artifacts)).sort()) {
    if(name==='receipt.json') continue;
    const bytes=await readFile(join(artifacts,name)); report.artifactManifest.push({name,bytes:bytes.length,sha256:sha256(bytes)});
  }
  report.artifactPolicy='Unique owner-only run directory; final files sealed owner-read-only with SHA-256 manifest. Keep receipt and artifacts private.';
  await saveReport();
  for (const name of await readdir(artifacts)) await chmod(join(artifacts,name),0o400);
  await chmod(artifacts,0o500);
  console.log(JSON.stringify({status:report.status,checks:report.checks.length,receipt:join(artifacts,'receipt.json')}));
}
