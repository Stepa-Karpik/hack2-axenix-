import * as THREE from './vendor/three.module.js';

// Three bevelled, interlocking rounded-square links, modelled in world space.
// Both the camera and studio stay fixed while the geometry rotates around Y.
export function initSculpture() {
  const host = document.querySelector('.sculpture');
  const hero = document.querySelector('.hero');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const scene = new THREE.Scene();
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute('aria-hidden', 'true');
  host.append(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(33, 1, .1, 50);
  camera.position.set(0, .15, 7.8);
  camera.lookAt(0, 0, 0);

  // Large studio softboxes become real, view-dependent chrome reflections.
  // Generate this environment locally, without an HDR download or CDN.
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(0x101013);
  const panels = [];
  function softbox(x, y, z, width, height, intensity) {
    const geometry = new THREE.PlaneGeometry(width, height);
    const material = new THREE.MeshBasicMaterial({ color: new THREE.Color(intensity, intensity, intensity), side: THREE.DoubleSide });
    const panel = new THREE.Mesh(geometry, material);
    panel.position.set(x, y, z);
    panel.lookAt(0, 0, 0);
    studio.add(panel);
    panels.push(panel);
  }
  softbox(-4, 2, 3, 2.5, 7, 3.8);
  softbox(4, .5, 1, 1.8, 7, 2.8);
  softbox(0, 5, 0, 6, 2.5, 3.2);
  softbox(-1, -4, 2, 5, 1.5, 1.1);
  softbox(1, 1, -5, 2.8, 5, 2.5);
  softbox(-2, 0, 6, 3, 6, .5);
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(studio, .065);
  scene.environment = environment.texture;
  panels.forEach(panel => { panel.geometry.dispose(); panel.material.dispose(); });
  pmrem.dispose();

  const material = new THREE.MeshPhysicalMaterial({
    color: 0xd9dce1, metalness: 1, roughness: .155,
    clearcoat: .65, clearcoatRoughness: .16, envMapIntensity: 1.1,
  });

  function roundedRect(path, width, height, radius, clockwise = false) {
    const x = -width / 2, y = -height / 2;
    path.moveTo(x + radius, y);
    path.lineTo(x + width - radius, y);
    path.quadraticCurveTo(x + width, y, x + width, y + radius);
    path.lineTo(x + width, y + height - radius);
    path.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
    path.lineTo(x + radius, y + height);
    path.quadraticCurveTo(x, y + height, x, y + height - radius);
    path.lineTo(x, y + radius);
    path.quadraticCurveTo(x, y, x + radius, y);
    path.closePath();
    if (clockwise) path.curves.reverse().forEach(curve => {
      if (curve.isLineCurve) [curve.v1, curve.v2] = [curve.v2, curve.v1];
      else [curve.v0, curve.v2] = [curve.v2, curve.v0];
    });
  }
  const shape = new THREE.Shape();
  roundedRect(shape, 2.9, 1.8, .57);
  const hole = new THREE.Path();
  roundedRect(hole, 2.26, 1.16, .29, true);
  shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: .16, bevelEnabled: true, bevelSegments: 10,
    steps: 1, bevelSize: .12, bevelThickness: .12, curveSegments: 28,
  });
  geometry.center();

  const pointerPivot = new THREE.Group();
  const spin = new THREE.Group();
  const composition = new THREE.Group();
  composition.rotation.set(.48, -.52, -.38);
  const diagonalAxis = new THREE.Vector3(1, 1, 1).normalize();
  // A compact Borromean arrangement: each oblong passes through the other
  // two in a different plane. All three centres coincide; no chain spacing.
  for (let i = 0; i < 3; i++) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.quaternion.setFromAxisAngle(diagonalAxis, i * Math.PI * 2 / 3);
    composition.add(mesh);
  }
  spin.add(composition);
  pointerPivot.add(spin);
  scene.add(pointerPivot);

  let visible = true;
  let frame = 0;
  let lastTime = 0;
  let targetX = 0;
  let targetY = 0;
  let contextLost = false;

  const canAnimate = () => visible && !document.hidden && !reduced.matches && !contextLost;
  function draw(time) {
    frame = 0;
    const delta = lastTime ? Math.min((time - lastTime) / 1000, .05) : 0;
    lastTime = time;
    if (!reduced.matches) spin.rotation.y = (spin.rotation.y + delta * Math.PI * 2 / 24) % (Math.PI * 2);
    const ease = 1 - Math.exp(-Math.max(delta, .016) * 5);
    pointerPivot.rotation.x += (targetX - pointerPivot.rotation.x) * ease;
    pointerPivot.rotation.y += (targetY - pointerPivot.rotation.y) * ease;
    renderer.render(scene, camera);
    host.dataset.angle = spin.rotation.y.toFixed(3);
    host.dataset.tilt = `${pointerPivot.rotation.x.toFixed(3)},${pointerPivot.rotation.y.toFixed(3)}`;
    if (canAnimate()) frame = requestAnimationFrame(draw);
  }
  function start() {
    if (!frame && !contextLost) { lastTime = 0; frame = requestAnimationFrame(draw); }
  }
  function updatePlayback() {
    if (canAnimate()) start();
    else { cancelAnimationFrame(frame); frame = 0; lastTime = 0; }
  }
  const resize = new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (!width || !height || contextLost) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  });
  resize.observe(host);
  hero.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || reduced.matches) return;
    const rect = hero.getBoundingClientRect();
    targetY = ((event.clientX - rect.left) / rect.width - .5) * .32;
    targetX = ((event.clientY - rect.top) / rect.height - .5) * .20;
  }, { passive: true });
  hero.addEventListener('pointerleave', () => { targetX = 0; targetY = 0; });
  const observer = new IntersectionObserver(([entry]) => { visible = entry.isIntersecting; updatePlayback(); });
  observer.observe(host);
  document.addEventListener('visibilitychange', updatePlayback);
  reduced.addEventListener('change', () => {
    if (reduced.matches) {
      targetX = 0; targetY = 0;
      pointerPivot.rotation.set(0, 0, 0);
      spin.rotation.y = 0;
      renderer.render(scene, camera);
    }
    updatePlayback();
  });
  renderer.domElement.addEventListener('webglcontextlost', event => {
    event.preventDefault(); contextLost = true; updatePlayback();
    host.dataset.renderer = 'fallback';
  });
  renderer.domElement.addEventListener('webglcontextrestored', () => {
    contextLost = false; host.dataset.renderer = 'webgl'; start();
  });
  renderer.setSize(host.clientWidth, host.clientHeight, false);
  renderer.render(scene, camera);
  host.dataset.renderer = 'webgl';
  host.dataset.links = String(composition.children.length);
  start();
}
