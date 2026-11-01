// Original line icons drawn for Tintwork (24x24 grid, stroke-based).
const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
export const ICONS = {
  move: svg('<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>'),
  select: svg('<rect x="4" y="5" width="16" height="14" rx="1" stroke-dasharray="3 2.4"/>'),
  crop: svg('<path d="M7 2v15h15M2 7h15v15"/>'),
  brush: svg('<path d="M20 4l-9.5 9.5"/><path d="M10.5 13.5c-2-.4-4 .9-4.4 3.2-.3 1.6-1.3 2.6-3.1 3 3.4 1.2 7.7.6 8.8-2.2.6-1.6.3-3.1-1.3-4z"/>'),
  eraser: svg('<path d="M8.5 20H20M4.6 15.4l9.9-9.9a2 2 0 012.8 0l2.2 2.2a2 2 0 010 2.8L10 20H8.5l-3.9-3.9a.5.5 0 010-.7z"/><path d="M9 11l5 5"/>'),
  fill: svg('<path d="M5 11l7-7 7 7-7 7z"/><path d="M5 11h14"/><path d="M20 15s-1.6 2-1.6 3.1a1.6 1.6 0 003.2 0C21.6 17 20 15 20 15z"/>'),
  text: svg('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  eyedropper: svg('<path d="M14.5 5.5l4 4M17 3a2.1 2.1 0 013 3l-2 2-3-3z"/><path d="M15 7l-9 9-1.5 4.5L9 19l9-9"/>'),
  hand: svg('<path d="M8 12V5.5a1.5 1.5 0 013 0V11M11 10V4.5a1.5 1.5 0 013 0V11M14 10.5V6a1.5 1.5 0 013 0v7.5c0 4-2.5 7-6.5 7-2.6 0-4-1.3-5.4-3.4L3.4 13.6a1.5 1.5 0 012.5-1.6L8 14"/>'),
  zoom: svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>'),
  layerNew: svg('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M12 8v8M8 12h8"/>'),
  layerDuplicate: svg('<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 00-1-1H5a1 1 0 00-1 1v10a1 1 0 001 1h3"/>'),
  layerUp: svg('<path d="M12 19V5M6 11l6-6 6 6"/>'),
  layerDown: svg('<path d="M12 5v14M6 13l6 6 6-6"/>'),
  layerMergeDown: svg('<path d="M12 4v10M8 10l4 4 4-4M4 19h16"/>'),
  layerDelete: svg('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>'),
  eye: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
};
