// Platform-aware keyboard handling and labels.
// macOS (and iPadOS with a keyboard): Command (⌘) is the primary modifier, Option (⌥) the secondary, and labels use
// symbols in the standard Mac order (⌃ ⌥ ⇧ ⌘ key). Windows / Linux / ChromeOS: Ctrl is primary, and labels read Ctrl+Alt+Shift+Key.
// Shortcuts are written once in a neutral form ('Ctrl+Shift+Z'); Ctrl means "the primary modifier".

function detectMac() {
  try {
    const forced = new URLSearchParams(location.search).get('platform') || localStorage.getItem('tintwork.platform');
    if (forced === 'mac') return true;
    if (forced === 'win' || forced === 'linux') return false;
  } catch { /* storage may be blocked */ }
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
  if (/mac|iphone|ipad|ipod/i.test(p)) return true;
  return /Mac OS X|Macintosh/.test(navigator.userAgent) && !/Windows|Linux|CrOS/.test(p);
}

export const IS_MAC = detectMac();
export const PLATFORM = IS_MAC ? 'mac' : 'other';

/** The primary command modifier for this platform (⌘ on Mac, Ctrl elsewhere). */
export const primaryMod = (e) => (IS_MAC ? e.metaKey : e.ctrlKey);

const MAC_SYM = { Ctrl: '⌘', Alt: '⌥', Shift: '⇧', Control: '⌃' };
const MAC_ORDER = ['Control', 'Alt', 'Shift', 'Ctrl'];
const MAC_KEYS = { Del: '⌦', Delete: '⌦', Backspace: '⌫', Enter: '↩', Esc: 'esc', Escape: 'esc', Tab: '⇥', Space: 'Space' };

/** 'Ctrl+Shift+Z' → '⇧⌘Z' (Mac) or 'Ctrl+Shift+Z' (others). Several alternatives separated by ' / ' are kept. */
export function keyLabel(spec) {
  if (!spec) return '';
  return spec.split(' / ').map((one) => {
    const parts = one.split('+'); let key = parts.pop(); if (key === '' && parts.length) { parts.pop(); key = '+'; }
    if (!IS_MAC) return [...parts, key].join('+');
    const mods = MAC_ORDER.filter((m) => parts.includes(m)).map((m) => MAC_SYM[m]).join('');
    return mods + (MAC_KEYS[key] || key);
  }).join(' / ');
}

/** Rewrite modifier names inside running text ("Alt+click", "Shift keeps aspect", "Ctrl+edge skews") for this platform. */
export function platformText(s) {
  if (!IS_MAC || !s) return s;
  return s
    .replace(/\b((?:(?:Ctrl|Alt|Shift)\+)+)([A-Za-z0-9[\]\\?=+\-⌫]+)/g, (m, mods, key) => {
      const list = mods.split('+').filter(Boolean), sym = MAC_ORDER.filter((x) => list.includes(x)).map((x) => MAC_SYM[x]).join('');
      return /^[a-z]{2,}$/.test(key) ? `${sym}-${key}` : sym + (MAC_KEYS[key] || key);
    })
    .replace(/\bCtrl\/Cmd\b/g, '⌘').replace(/\bCtrl\b/g, '⌘').replace(/\bAlt\b/g, '⌥').replace(/\bShift\b/g, '⇧');
}

/** Keyboard event → neutral combo string ('mod+alt+shift+n'). On Mac, Option changes e.key (⌥N → '˜'), so letters and digits
 *  come from e.code when Option is held. Ctrl on Mac (⌃) is its own modifier and never acts as the primary one. */
export function comboOf(e) {
  let key = (e.key || '').toLowerCase();
  if (e.altKey && e.code) {
    if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase();
    else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
    else if (e.code === 'Minus') key = '-'; else if (e.code === 'Equal') key = '=';
    else if (e.code === 'BracketLeft') key = '['; else if (e.code === 'BracketRight') key = ']';
  }
  const ctrlOnMac = IS_MAC && e.ctrlKey && !e.metaKey;
  return (ctrlOnMac ? 'ctrl+' : '') + (primaryMod(e) ? 'mod+' : '') + (e.shiftKey ? 'shift+' : '') + (e.altKey ? 'alt+' : '') + key;
}

/** Shortcuts the browser or OS keeps for itself (the page never sees them, or cannot cancel them). Each has an alternate. */
export const RESERVED = IS_MAC
  ? new Set(['mod+n', 'mod+t', 'mod+w', 'mod+q', 'mod+m', 'mod+h', 'mod+shift+n', 'mod+shift+t', 'mod+shift+w', 'mod+shift+tab', 'mod+`', 'mod+,', 'mod+alt+i', 'mod+alt+c'])
  : new Set(['mod+n', 'mod+t', 'mod+w', 'mod+shift+n', 'mod+shift+t', 'mod+shift+w', 'mod+shift+i', 'mod+shift+j', 'mod+shift+c', 'mod+tab', 'mod+shift+tab', 'alt+f4']);
