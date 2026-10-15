// Real build identity, baked in at build time by vite.config.js's
// `define` block -- never a hand-typed label. __APP_VERSION__ comes from
// package.json's version (bumped by hand on a real release); __BUILD_SHA__
// is the real git commit the build was made from (or 'dev' outside a git
// checkout). Together they answer "what's actually live" unambiguously,
// even between version bumps.
export const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
export const BUILD_SHA = typeof __BUILD_SHA__ !== 'undefined' ? __BUILD_SHA__ : 'dev';
export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : null;

export const APP_VERSION_LABEL = `v${APP_VERSION} · ${BUILD_SHA}`;
