// Anchors work immediately, including when the session request is unavailable.
fetch('/api/v1/session', { credentials: 'same-origin', cache: 'no-store' })
  .then(response => response.ok ? response.json() : null)
  .then(payload => {
    if (payload?.data?.mode !== 'authenticated') return;
    const login = document.querySelector('[data-action="login"]');
    if (login) { login.href = '/projects'; login.textContent = 'Мои проекты'; }
  })
  .catch(() => {});

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const hoverPointer = window.matchMedia('(hover: hover) and (pointer: fine)');

for (const card of document.querySelectorAll('.depth-card')) {
  const image = card.querySelector('.depth-image');
  let pointerInside = false;
  let focused = false;
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let raf = 0;
  let previousTime = 0;

  const render = (time) => {
    const delta = previousTime ? Math.min(time - previousTime, 40) : 16;
    previousTime = time;
    const easing = 1 - Math.exp(-delta / 95);
    currentX += (targetX - currentX) * easing;
    currentY += (targetY - currentY) * easing;
    image.style.transform = `translate3d(${currentX.toFixed(3)}px, ${currentY.toFixed(3)}px, 0)`;

    if (Math.abs(targetX - currentX) > 0.015 || Math.abs(targetY - currentY) > 0.015) {
      raf = requestAnimationFrame(render);
    } else {
      currentX = targetX;
      currentY = targetY;
      image.style.transform = `translate3d(${targetX}px, ${targetY}px, 0)`;
      raf = 0;
      previousTime = 0;
    }
  };

  const animateTo = (x, y) => {
    targetX = reducedMotion.matches ? 0 : x;
    targetY = reducedMotion.matches ? 0 : y;
    if (!raf) raf = requestAnimationFrame(render);
  };

  const setActive = () => {
    card.classList.toggle('is-active', pointerInside || focused);
  };

  card.addEventListener('pointerenter', (event) => {
    if (event.pointerType !== 'mouse' || !hoverPointer.matches) return;
    pointerInside = true;
    setActive();
  });

  card.addEventListener('pointermove', (event) => {
    if (!pointerInside || reducedMotion.matches) return;
    const rect = card.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 2;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * 2;
    // Keep movement within the image's overscan; no edges can enter the frame.
    const travelX = Math.min(30, rect.width * 0.065);
    const travelY = Math.min(24, rect.height * 0.085);
    animateTo(x * travelX, y * travelY);
  });

  const leave = () => {
    pointerInside = false;
    setActive();
    animateTo(0, 0);
  };

  card.addEventListener('pointerleave', leave);
  card.addEventListener('pointercancel', leave);
  card.addEventListener('focus', () => {
    focused = card.matches(':focus-visible') || !hoverPointer.matches;
    setActive();
  });
  card.addEventListener('blur', () => {
    focused = false;
    setActive();
    animateTo(0, 0);
  });
  reducedMotion.addEventListener('change', () => animateTo(0, 0));
}

// The image is a static fallback only. Motion comes from actual mesh geometry.
import('./sculpture.js').then(({ initSculpture }) => initSculpture()).catch((error) => {
  console.warn('3D sculpture is unavailable; displaying the static fallback.', error);
});

// Keep the overview intact; open the original pixels when details matter.
const viewer = document.querySelector('.image-viewer');
const zoomButton = viewer.querySelector('.viewer-zoom');
document.querySelector('.preview-open').addEventListener('click', () => {
  viewer.classList.remove('is-zoomed');
  zoomButton.textContent = 'Увеличить';
  zoomButton.setAttribute('aria-pressed', 'false');
  viewer.showModal();
  document.documentElement.style.overflow = 'hidden';
});
viewer.querySelector('.viewer-close').addEventListener('click', () => viewer.close());
viewer.addEventListener('close', () => { document.documentElement.style.overflow = ''; });
viewer.addEventListener('click', event => { if (event.target === viewer) viewer.close(); });
zoomButton.addEventListener('click', () => {
  const zoomed = viewer.classList.toggle('is-zoomed');
  zoomButton.textContent = zoomed ? 'Вписать' : 'Увеличить';
  zoomButton.setAttribute('aria-pressed', String(zoomed));
});
