'use strict';
/**
 * Fallback si node-fetch est incomplet en build (lib/index.js manquant).
 * discord-rpc n'utilise que fetch(url, opts) puis .json() / .ok — identique au fetch natif.
 */
module.exports = globalThis.fetch;
