// @vitest-environment node

import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { build } from 'vite';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PWA deployment paths', () => {
  it('builds an installable app under a non-root base path', async () => {
    const output = await mkdtemp(join(tmpdir(), 'spinner-pwa-'));
    temporaryDirectories.push(output);
    const priorNodeEnvironment = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await build({
        root: process.cwd(),
        base: '/school/spinner/',
        mode: 'production',
        logLevel: 'silent',
        build: { outDir: output, emptyOutDir: true },
      });
    } finally {
      if (priorNodeEnvironment === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnvironment;
    }

    const index = await readFile(join(output, 'index.html'), 'utf8');
    expect(index).toContain('href="/school/spinner/manifest.webmanifest"');
    expect(index).toContain('href="/school/spinner/icon.svg"');
    expect(index).toContain('<title>ShapeCut｜3D 陀螺模型轉 Laser Cut 切片</title>');
    expect(index).toContain('content="#14b8a6"');
    expect(index).not.toMatch(/陀螺 Laser Kit|多材料/i);

    const manifest = JSON.parse(await readFile(join(output, 'manifest.webmanifest'), 'utf8'));
    expect(manifest).toMatchObject({ start_url: './', scope: './' });
    expect(manifest).toMatchObject({
      name: 'ShapeCut', short_name: 'ShapeCut',
      description: '把 3D 陀螺 STL 模型轉換成 Laser Cut 平面切片及製作檔案的瀏覽器工具。',
      background_color: '#ffffff', theme_color: '#14b8a6',
    });
    expect(JSON.stringify(manifest)).not.toMatch(/spinner|material/i);
    expect(manifest.icons[0].src).toBe('icon.svg');
    const icon = await readFile(join(output, manifest.icons[0].src), 'utf8');
    expect(icon).toContain('ShapeCut layered outline');
    expect(icon).toContain('#14b8a6');
    expect(icon).toContain('#fff');
    expect(icon).not.toMatch(/#0f172a|#38bdf8|#f59e0b|陀螺|spinner|material/i);

    const scripts = (await readdir(join(output, 'assets'))).filter((file) => file.endsWith('.js'));
    const javascript = (await Promise.all(scripts.map((file) => readFile(join(output, 'assets', file), 'utf8')))).join('\n');
    expect(javascript.includes('/school/spinner/sw.js'), 'compiled service-worker registration must include the deployment base').toBe(true);

    const serviceWorker = await readFile(join(output, 'sw.js'), 'utf8');
    expect(serviceWorker).toContain("const CACHE = 'spinner-laser-kit-shell-v3'");
    expect(serviceWorker).toContain("key.startsWith('spinner-laser-kit-shell-') && key !== CACHE");
    expect(serviceWorker).toContain('self.registration.scope');
    expect(serviceWorker).not.toContain("const SHELL = ['/',");
    expect(serviceWorker).toContain("request.method !== 'GET'");
    expect(serviceWorker).toContain('url.origin !== self.location.origin');
    expect(serviceWorker).toContain("url.pathname.endsWith('.stl')");

    const freshnessBranchStart = serviceWorker.indexOf("request.mode === 'navigate'");
    const staticCacheFirstStart = serviceWorker.indexOf('event.respondWith(caches.match(request)');
    expect(freshnessBranchStart).toBeGreaterThan(-1);
    expect(staticCacheFirstStart).toBeGreaterThan(freshnessBranchStart);
    const freshnessBranch = serviceWorker.slice(freshnessBranchStart, staticCacheFirstStart);
    expect(freshnessBranch).toContain("['document', 'manifest'].includes(request.destination)");
    expect(freshnessBranch).toContain('fetch(request).then((response) => {');
    expect(freshnessBranch).toContain('if (response.ok)');
    expect(freshnessBranch).toContain('cache.put(request, copy)');
    expect(freshnessBranch).toContain('event.waitUntil(cacheUpdate)');
    expect(freshnessBranch).toContain('.catch(() => caches.match(request))');
  }, 20_000);
});
