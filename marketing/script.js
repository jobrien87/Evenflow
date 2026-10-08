// Mobile nav toggle only — no framework, no tracking.
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.getElementById('nav-toggle');
  const drawer = document.getElementById('mobile-drawer');

  if (toggle && drawer) {
    toggle.addEventListener('click', () => {
      const isOpen = document.body.classList.toggle('nav-open');
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.textContent = isOpen ? '✕' : '☰';
    });

    drawer.querySelectorAll('a').forEach((link) => {
      link.addEventListener('click', () => {
        document.body.classList.remove('nav-open');
        toggle.setAttribute('aria-expanded', 'false');
        toggle.textContent = '☰';
      });
    });
  }

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // Log In currently points at the live app — swap this placeholder for
  // the real deployed app URL before this site goes live (see the
  // rollout notes delivered alongside this build).
  const APP_URL = 'https://evenflow-client.onrender.com';
  document.querySelectorAll('#login-link, #login-link-mobile').forEach((el) => {
    el.setAttribute('href', APP_URL);
  });
});
