#!/usr/bin/env node
// Copies the `three` npm package's ES module builds (classic WebGLRenderer and WebGPURenderer +
// TSL), plus the postprocessing/shaders addons the site's bloom pipeline needs and the TSL
// display addons (bloom/afterimage/chromatic-aberration nodes) the WebGPU scene uses, into
// site/vendor/three/ — this is a static site with no bundler,
// so the browser imports these files directly (via each page's <script type="importmap">).
// Regenerated from node_modules on every install/release (ci.yml, release.yml); never
// hand-edited. Run: node scripts/vendor-three.mjs
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules/three');
const dest = join(root, 'site/vendor/three');

if (!existsSync(src)) {
  console.error('node_modules/three missing — run npm ci first');
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(join(src, 'build/three.module.js'), join(dest, 'three.module.js'));
// three.module.js imports from './three.core.js' internally (0.186 split the build in two).
cpSync(join(src, 'build/three.core.js'), join(dest, 'three.core.js'));
// 'three/webgpu' (WebGPURenderer, node materials) and 'three/tsl' share that same core file.
cpSync(join(src, 'build/three.webgpu.js'), join(dest, 'three.webgpu.js'));
cpSync(join(src, 'build/three.tsl.js'), join(dest, 'three.tsl.js'));
cpSync(join(src, 'examples/jsm/postprocessing'), join(dest, 'addons/postprocessing'), { recursive: true });
cpSync(join(src, 'examples/jsm/shaders'), join(dest, 'addons/shaders'), { recursive: true });
// Only the TSL display nodes mc3's WebGPU scene imports; each imports nothing but three/webgpu
// and three/tsl.
mkdirSync(join(dest, 'addons/tsl/display'), { recursive: true });
for (const node of ['BloomNode.js', 'AfterImageNode.js', 'ChromaticAberrationNode.js']) {
  cpSync(join(src, 'examples/jsm/tsl/display', node), join(dest, 'addons/tsl/display', node));
}

// Self-check: the files every scene imports must actually be there, or every page that
// imports 'three'/'three/addons/...' would fail silently at runtime instead of at build time.
for (const must of [
  'three.module.js',
  'three.core.js',
  'three.webgpu.js',
  'three.tsl.js',
  'addons/postprocessing/EffectComposer.js',
  'addons/postprocessing/RenderPass.js',
  'addons/postprocessing/UnrealBloomPass.js',
  'addons/postprocessing/OutputPass.js',
  'addons/tsl/display/BloomNode.js',
  'addons/tsl/display/AfterImageNode.js',
  'addons/tsl/display/ChromaticAberrationNode.js',
]) {
  if (!existsSync(join(dest, must))) {
    console.error(`vendor-three: expected ${must} after copy, not found`);
    process.exit(1);
  }
}
console.log('vendored three ->', dest);
