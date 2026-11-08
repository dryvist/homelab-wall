const arcOpacity = (rate) => Math.max(0.12, Math.min(0.82, 0.12 + Math.log1p(Math.max(0, rate || 0)) * 0.22));

function arcControl(THREE, from, to) {
  const middle = from.clone().add(to).multiplyScalar(0.5);
  if (middle.lengthSq() < 1) middle.set(0, 1, 0);
  return middle.normalize().multiplyScalar(91);
}

export function createTrafficArcs(THREE, group, home, llToVec) {
  const layer = new THREE.Group();
  group.add(layer);
  const arcs = [];
  let signature = '';

  function update(countries) {
    const key = countries.map(({ code, rate, center }) => `${code}:${rate}:${center.join(',')}`).join('|');
    if (key === signature) return;
    signature = key;
    for (const arc of arcs) {
      layer.remove(arc.line, arc.particle);
      arc.line.geometry.dispose();
      arc.line.material.dispose();
      arc.particle.geometry.dispose();
      arc.particle.material.dispose();
    }
    arcs.length = 0;
    for (const country of countries) {
      const from = llToVec(...country.center, 80);
      const curve = new THREE.QuadraticBezierCurve3(from, arcControl(THREE, from, home), home);
      const rate = Number.isFinite(country.rate) ? country.rate : 0;
      const opacity = arcOpacity(rate);
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(curve.getPoints(48)),
        new THREE.LineBasicMaterial({ color: 0xff3350, transparent: true, opacity, depthWrite: false }),
      );
      const particleMaterial = new THREE.MeshBasicMaterial({ color: 0x9beeff, transparent: true, opacity: rate > 0 ? Math.min(1, opacity + 0.15) : 0, depthWrite: false });
      const particle = new THREE.Mesh(new THREE.SphereGeometry(1.15, 8, 8), particleMaterial);
      layer.add(line, particle);
      arcs.push({ curve, line, particle, rate, phase: 0 });
    }
  }

  function render(deltaMs) {
    for (const arc of arcs) {
      if (arc.rate > 0) arc.phase = (arc.phase + arc.rate * deltaMs / 1000) % 1;
      arc.particle.position.copy(arc.curve.getPoint(arc.phase));
    }
  }

  return { update, render, count: () => arcs.length };
}

export function faceTraffic(THREE, home, country, llToVec, fallback) {
  if (!country) return fallback;
  const origin = llToVec(...country.center).normalize();
  const midpoint = home.clone().normalize().add(origin);
  if (midpoint.lengthSq() < 1e-4) midpoint.copy(origin);
  const facing = new THREE.Vector3(0, 0.32, 0.947).normalize();
  return new THREE.Quaternion().setFromUnitVectors(midpoint.normalize(), facing);
}

export function createTrafficMap2d(home, reducedMotion) {
  let yaw = home[1] * Math.PI / 180;
  let pitch = home[0] * Math.PI / 180;
  let previousTime = null;
  const phases = new Map();
  const project = (lat, lon, cx, cy, radius) => {
    const la = lat * Math.PI / 180, lo = lon * Math.PI / 180 - yaw;
    return { x: cx + Math.cos(la) * Math.sin(lo) * radius, y: cy - Math.sin(la - pitch) * radius };
  };

  return function drawTraffic(ctx, countries, target, cx, cy, radius, now) {
    const delta = previousTime == null ? 0 : Math.min(100, Math.max(0, now - previousTime));
    previousTime = now;
    const targetLon = target?.center?.[1] ?? home[1];
    const targetLat = target?.center?.[0] ?? home[0];
    const difference = ((targetLon - home[1] + 540) % 360) - 180;
    const desiredYaw = (home[1] + difference / 2) * Math.PI / 180;
    const yawDiff = ((desiredYaw - yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    const turn = reducedMotion ? 1 : 1 - Math.exp(-delta / 5000);
    yaw += yawDiff * turn;
    pitch += ((home[0] + targetLat) / 2 * Math.PI / 180 - pitch) * turn;

    const homePoint = project(...home, cx, cy, radius);
    ctx.save();
    ctx.lineWidth = Math.max(1, radius * 0.006);
    for (const country of countries) {
      const from = project(...country.center, cx, cy, radius);
      const rate = Number.isFinite(country.rate) ? country.rate : 0;
      const opacity = arcOpacity(rate);
      const midX = (from.x + homePoint.x) / 2, midY = (from.y + homePoint.y) / 2;
      const length = Math.hypot(cx - midX, cy - midY) || 1;
      const height = radius * (0.18 + opacity * 0.24);
      const controlX = midX + (cx - midX) * height / length;
      const controlY = midY + (cy - midY) * height / length;
      ctx.globalAlpha = opacity;
      ctx.strokeStyle = '#ff3350';
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.quadraticCurveTo(controlX, controlY, homePoint.x, homePoint.y);
      ctx.stroke();
      const phase = phases.get(country.code) ?? 0;
      const next = rate > 0 && !reducedMotion ? (phase + rate * delta / 1000) % 1 : phase;
      phases.set(country.code, next);
      if (rate > 0) {
        const t = reducedMotion ? 0.5 : next;
        const u = 1 - t;
        const x = u * u * from.x + 2 * u * t * controlX + t * t * homePoint.x;
        const y = u * u * from.y + 2 * u * t * controlY + t * t * homePoint.y;
        ctx.globalAlpha = opacity;
        ctx.fillStyle = '#9beeff';
        ctx.beginPath();
        ctx.arc(x, y, Math.max(1.5, radius * 0.012), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#9beeff';
    ctx.strokeStyle = 'rgba(155,238,255,.78)';
    ctx.beginPath();
    ctx.arc(homePoint.x, homePoint.y, Math.max(2.5, radius * 0.023), 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(homePoint.x, homePoint.y, Math.max(5, radius * 0.045), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  };
}
