import * as THREE from 'three';
import { hardwareGL, observeCanvas, onContextLoss, disposeThreeScene } from '/lib/stage.js';
import { edgeMotion, layoutTopology } from '/lib/mc1Topology.js';

const mapPoint = (point, width, height, scale = 0.16) => new THREE.Vector3((point.x - width / 2) * scale, 0, (point.y - height / 2) * scale);

function createWebGL(canvas, labels, reducedMotion, model, details) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(48, 1, 1, 900);
  const cameraDistance = 220;
  const layer = new THREE.Group(); scene.add(layer);
  const grid = new THREE.GridHelper(320, 32, 0x0f3a55, 0x0a2233); grid.position.y = -24; scene.add(grid);
  const starPositions = [];
  for (let i = 0; i < 360; i++) starPositions.push((Math.random() - 0.5) * 620, Math.random() * 240 - 80, (Math.random() - 0.5) * 620);
  const starGeometry = new THREE.BufferGeometry(); starGeometry.setAttribute('position', new THREE.Float32BufferAttribute(starPositions, 3));
  scene.add(new THREE.Points(starGeometry, new THREE.PointsMaterial({ color: 0x2a6c8a, size: 1.1, transparent: true, opacity: 0.55 })));
  const glowCanvas = document.createElement('canvas'); glowCanvas.width = glowCanvas.height = 64;
  const context = glowCanvas.getContext('2d'), gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, 'rgba(255,255,255,1)'); gradient.addColorStop(0.25, 'rgba(255,255,255,.5)'); gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient; context.fillRect(0, 0, 64, 64);
  const glowTexture = new THREE.CanvasTexture(glowCanvas);
  const glow = (color, size) => {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color, blending: THREE.AdditiveBlending, depthWrite: false, transparent: true }));
    sprite.scale.set(size, size, 1); return sprite;
  };
  const vector = new THREE.Vector3();
  let edgeDrawings = [], nodeDrawings = [];

  function clearLayer() {
    for (const child of [...layer.children]) {
      child.traverse((object) => {
        object.geometry?.dispose?.();
        for (const material of (Array.isArray(object.material) ? object.material : [object.material])) material?.dispose?.();
      });
      layer.remove(child);
    }
    edgeDrawings = []; nodeDrawings = [];
  }

  function rebuild(nextModel, nextDetails) {
    model = nextModel; details = nextDetails; clearLayer();
    const width = window.innerWidth, height = window.innerHeight, positions = model.positions || {};
    const nodeById = new Map(model.nodes.map((node) => [node.id, node]));
    for (const edge of model.edges) {
      const source = positions[edge.from], target = positions[edge.to];
      if (!source || !target) continue;
      const a = mapPoint(source, width, height), b = mapPoint(target, width, height);
      const arcIndex = edge.type === 'firewall' ? [...edgeDrawings].filter((item) => item.edge.type === 'firewall' && item.edge.from === edge.from && item.edge.to === edge.to).length : 0;
      const midpoint = a.clone().add(b).multiplyScalar(0.5); midpoint.y += edge.type === 'firewall' ? 18 + arcIndex * 8 : 7;
      const curve = new THREE.QuadraticBezierCurve3(a, midpoint, b);
      const color = new THREE.Color(edge.color || nodeById.get(edge.from)?.color || '#3ee6ff');
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(curve.getPoints(36)),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: edge.type === 'firewall' ? 0.48 : 0.25 }));
      layer.add(line);
      const motion = edgeMotion(edge), count = motion.density;
      const positionsBuffer = new Float32Array(Math.max(1, count) * 3), geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positionsBuffer, 3)); geometry.setDrawRange(0, 0);
      const material = new THREE.PointsMaterial({ map: glowTexture, color, size: edge.type === 'firewall' ? 3.2 : 3.8,
        blending: THREE.AdditiveBlending, depthWrite: false, transparent: true, opacity: 0.9 });
      layer.add(new THREE.Points(geometry, material));
      edgeDrawings.push({ edge, curve, geometry, positionsBuffer, material, count, motion });
    }
    for (const node of model.nodes) {
      const point = positions[node.id]; if (!point) continue;
      const position = mapPoint(point, width, height), color = new THREE.Color(node.color || '#3ee6ff');
      const group = new THREE.Group(); group.position.copy(position); layer.add(group);
      if (node.type === 'gateway') {
        group.add(glow(color, 38));
        group.add(new THREE.Mesh(new THREE.IcosahedronGeometry(7, 1), new THREE.MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.8 })));
        const ring = new THREE.Mesh(new THREE.TorusGeometry(12, 0.28, 6, 72), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 })); ring.rotation.x = Math.PI / 2; group.add(ring);
      } else if (node.type === 'device') {
        group.add(glow(color, 22));
        group.add(new THREE.Mesh(new THREE.BoxGeometry(7, 4, 7), new THREE.MeshBasicMaterial({ color, wireframe: true })));
      } else if (node.type === 'internet') {
        group.add(glow(color, 24)); group.add(new THREE.Mesh(new THREE.SphereGeometry(4, 12, 8), new THREE.MeshBasicMaterial({ color, wireframe: true })));
      } else {
        group.add(glow(color, 25));
        group.add(new THREE.Mesh(new THREE.OctahedronGeometry(4.4), new THREE.MeshBasicMaterial({ color, wireframe: true })));
        const ring = new THREE.Mesh(new THREE.RingGeometry(9, 9.35, 48), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.38 }));
        ring.rotation.x = Math.PI / 2; group.add(ring);
      }
      nodeDrawings.push({ node, group });
    }
  }
  rebuild(model, details);
  const resize = (width, height) => {
    renderer.setSize(width, height, false); camera.aspect = width / Math.max(height, 1); camera.updateProjectionMatrix();
    model = { ...model, positions: layoutTopology(model.nodes, window.innerWidth, window.innerHeight) };
    rebuild(model, details);
  };
  const observer = observeCanvas(document.documentElement, canvas, resize);
  const render = (now, dt) => {
    const seconds = now / 1000, angle = reducedMotion ? 0 : seconds * 0.045;
    layer.rotation.y = angle;
    camera.position.set(0, 36 + Math.sin(seconds * 0.18) * 4, cameraDistance); camera.lookAt(0, 0, 0);
    for (const drawing of edgeDrawings) {
      const { motion, count, positionsBuffer, geometry, material, curve, edge } = drawing;
      material.opacity = motion.density ? 0.48 + Math.min(0.48, motion.speed * 0.35) : 0;
      geometry.setDrawRange(0, motion.density ? count : 0);
      for (let index = 0; index < count && motion.density; index++) {
        let t = (seconds * motion.speed + index / count) % 1;
        if (edge.type !== 'firewall' && index % 2) t = 1 - t;
        const point = curve.getPoint(t), offset = index * 3;
        positionsBuffer[offset] = point.x; positionsBuffer[offset + 1] = point.y; positionsBuffer[offset + 2] = point.z;
      }
      geometry.attributes.position.needsUpdate = true;
    }
    for (const drawing of nodeDrawings) {
      const position = drawing.group.getWorldPosition(vector).project(camera), label = labels.querySelector(`[data-node-id="${CSS.escape(drawing.node.id)}"]`);
      if (!label) continue;
      label.style.left = `${(position.x + 1) * window.innerWidth / 2}px`;
      label.style.top = `${(1 - position.y) * window.innerHeight / 2}px`;
      label.style.opacity = position.z < 1 ? '1' : '0';
      if (drawing.node.type === 'vlan' || drawing.node.type === 'group') drawing.group.rotation.y += dt * 0.18;
    }
    renderer.render(scene, camera);
  };
  return { render, rebuild, renderer, scene, observer, glowTexture };
}

function rotatePoint(point, centerX, centerY, angle) {
  const x = point.x - centerX, y = point.y - centerY, c = Math.cos(angle), s = Math.sin(angle);
  return { x: centerX + x * c - y * s, y: centerY + x * s + y * c };
}

function drawCurve(context, a, b, type) {
  const bend = type === 'firewall' ? -Math.min(72, Math.max(24, Math.abs(a.x - b.x) * 0.16)) : -10;
  context.beginPath(); context.moveTo(a.x, a.y); context.quadraticCurveTo((a.x + b.x) / 2, (a.y + b.y) / 2 + bend, b.x, b.y);
}

export function createTopologyView({ canvas, labels, reducedMotion = false, forced = new URLSearchParams(location.search).get('gl') }) {
  const useWebGL = forced === '3d' || (forced !== '2d' && hardwareGL());
  let model = { nodes: [], edges: [], positions: {} }, details = () => '', webgl = null;
  let context2d = null, canvasObserver = null;
  const syncLabels = () => {
    const ids = model.nodes.map((node) => node.id), prior = [...labels.children].map((el) => el.dataset.nodeId);
    if (ids.join('\0') !== prior.join('\0')) {
      labels.replaceChildren();
      for (const node of model.nodes) {
        const label = document.createElement('div'), small = document.createElement('small');
        label.className = 'vl'; label.dataset.nodeId = node.id; label.dataset.nodeType = node.type; label.style.color = node.color || '#3ee6ff';
        label.append(document.createTextNode(''), small); labels.appendChild(label);
      }
    }
    for (const node of model.nodes) {
      const label = labels.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
      if (!label) continue;
      label.firstChild.textContent = node.name.toUpperCase();
      label.querySelector('small').textContent = details(node) || '';
    }
  };
  const update2dPositions = (now) => {
    const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
    const angle = reducedMotion ? 0 : now / 1000 * 0.045;
    return Object.fromEntries(Object.entries(model.positions).map(([id, point]) => [id, rotatePoint(point, width / 2, height / 2, angle)]));
  };
  const rebuild = () => {
    model = { ...model, positions: layoutTopology(model.nodes, window.innerWidth, window.innerHeight) };
    syncLabels();
    if (useWebGL) webgl?.rebuild(model, details);
  };
  if (useWebGL) {
    webgl = createWebGL(canvas, labels, reducedMotion, model, details);
    onContextLoss(canvas, () => {
      webgl.observer.disconnect();
      disposeThreeScene(webgl.renderer, webgl.scene);
      webgl = createWebGL(canvas, labels, reducedMotion, model, details);
    });
  } else {
    canvas.parentElement.querySelector('#topostate').textContent = '2D MODE';
    context2d = canvas.getContext('2d');
    canvasObserver = observeCanvas(document.documentElement, canvas);
  }
  if (useWebGL) canvas.parentElement.querySelector('#topostate').textContent = 'LIVE';
  const view = {
    mode: useWebGL ? '3d' : '2d',
    setModel(nextModel, labelDetails = () => '') {
      model = nextModel; details = labelDetails;
      model = { ...model, positions: layoutTopology(model.nodes, window.innerWidth, window.innerHeight) };
      syncLabels();
      if (useWebGL) webgl.rebuild(model, details);
    },
    render(now, dt) {
      if (useWebGL) { webgl.render(now, dt); return; }
      const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight;
      const sx = canvas.width / Math.max(width, 1), sy = canvas.height / Math.max(height, 1), positions = update2dPositions(now);
      context2d.setTransform(sx, 0, 0, sy, 0, 0); context2d.clearRect(0, 0, width, height);
      for (const edge of model.edges) {
        const a = positions[edge.from], b = positions[edge.to]; if (!a || !b) continue;
        const motion = edgeMotion(edge);
        context2d.strokeStyle = edge.color || '#3ee6ff'; context2d.globalAlpha = edge.type === 'firewall' ? 0.58 : 0.34; context2d.lineWidth = edge.type === 'firewall' ? 1.6 : 1;
        drawCurve(context2d, a, b, edge.type); context2d.stroke(); context2d.globalAlpha = 1;
        for (let index = 0; index < motion.density; index++) {
          let t = (now / 1000 * motion.speed + index / motion.density) % 1;
          if (edge.type !== 'firewall' && index % 2) t = 1 - t;
          const bend = edge.type === 'firewall' ? -Math.min(72, Math.max(24, Math.abs(a.x - b.x) * 0.16)) : -10;
          const inverse = 1 - t, x = inverse * inverse * a.x + 2 * inverse * t * ((a.x + b.x) / 2) + t * t * b.x;
          const y = inverse * inverse * a.y + 2 * inverse * t * ((a.y + b.y) / 2 + bend) + t * t * b.y;
          context2d.fillStyle = edge.color || '#3ee6ff'; context2d.beginPath(); context2d.arc(x, y, edge.type === 'firewall' ? 2 : 2.5, 0, Math.PI * 2); context2d.fill();
        }
      }
      for (const node of model.nodes) {
        const point = positions[node.id]; if (!point) continue;
        context2d.strokeStyle = node.color || '#3ee6ff'; context2d.fillStyle = 'rgba(4,7,12,.86)'; context2d.lineWidth = 2;
        context2d.beginPath();
        context2d.arc(point.x, point.y, node.type === 'gateway' ? 15 : node.type === 'device' ? 7 : 11, 0, Math.PI * 2);
        context2d.fill(); context2d.stroke();
        if (node.type === 'gateway') { context2d.beginPath(); context2d.arc(point.x, point.y, 22, 0, Math.PI * 2); context2d.stroke(); }
        const label = labels.querySelector(`[data-node-id="${CSS.escape(node.id)}"]`);
        if (label) { label.style.left = `${point.x}px`; label.style.top = `${point.y}px`; label.style.opacity = '1'; }
      }
    },
    dispose() {
      window.removeEventListener('resize', rebuild);
      canvasObserver?.disconnect();
      if (webgl) { webgl.observer.disconnect(); disposeThreeScene(webgl.renderer, webgl.scene); webgl.glowTexture.dispose(); }
    },
  };
  window.addEventListener('resize', rebuild);
  return view;
}
