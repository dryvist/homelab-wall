// Shared bloom post-processing pipeline for the three.js hero scenes (MC2/MC3/MC4).
//
// Engine choice: classic WebGLRenderer + EffectComposer/UnrealBloomPass, not WebGPURenderer.
// WebGPURenderer's own post-processing (three/addons/postprocessing/*, node-material/TSL based)
// is a different, newer stack than the classic EffectComposer used here, and its browser support
// is still WebGPU-only with no automatic WebGL2 fallback baked into the renderer itself — a much
// bigger risk surface for a kiosk that must render correctly under Playwright's bundled Chromium
// today. WebGLRenderer + UnrealBloomPass is the proven, small, already-used-by-MC1/MC2 path: same
// renderer class, same material types, one extra composer object. Revisit WebGPU once it ships a
// stable classic-EffectComposer-compatible pipeline.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// renderer/scene/cam are already constructed by the caller; this only adds the bloom chain.
// Returns { render(), setSize(w,h), dispose() } — dispose() only tears down the composer's own
// render targets/passes, never the renderer itself (site/lib/stage.js disposeThreeScene owns that).
export function makeBloom(renderer, scene, cam, { strength = 1.1, radius = 0.5, threshold = 0.15 } = {}) {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, cam));
  const bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), strength, radius, threshold);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
  return {
    render: () => composer.render(),
    setSize: (w, h) => { composer.setSize(w, h); bloom.resolution.set(w, h); },
    dispose: () => composer.dispose(),
  };
}
