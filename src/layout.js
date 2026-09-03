'use strict';

const PHONE_ASPECT = 9 / 16;

function normalizeInsets(insets) {
  return { top: 0, right: 0, bottom: 0, left: 0, ...(insets || {}) };
}

// Returns one {x, y, width, height} per feed, left to right. Pure arithmetic —
// no platform calls — so it can be unit tested directly.
function computeLayout({ screen, count, layout = 'columns', gap = 0, insets }) {
  if (count < 1) return [];
  const pad = normalizeInsets(insets);
  // The screen may be a secondary display sitting at a non-zero desktop
  // offset, so every coordinate is relative to its origin, not to 0,0.
  const originX = screen.x || 0;
  const originY = screen.y || 0;
  const usableWidth = Math.max(1, screen.width - pad.left - pad.right);
  const usableHeight = Math.max(1, screen.height - pad.top - pad.bottom);
  const totalGap = gap * (count - 1);

  if (layout === 'phones') {
    // Phone-shaped windows, as tall as the screen allows, centered as a row.
    // If three 9:16 windows won't fit side by side, height shrinks until they do.
    let height = usableHeight;
    let width = Math.floor(height * PHONE_ASPECT);
    if (width * count + totalGap > usableWidth) {
      width = Math.floor((usableWidth - totalGap) / count);
      height = Math.floor(width / PHONE_ASPECT);
    }
    const rowWidth = width * count + totalGap;
    const startX = originX + pad.left + Math.floor((usableWidth - rowWidth) / 2);
    const startY = originY + pad.top + Math.floor((usableHeight - height) / 2);
    return Array.from({ length: count }, (_, i) => ({
      x: startX + i * (width + gap),
      y: startY,
      width,
      height,
    }));
  }

  // Default: equal full-height columns. The last column absorbs the rounding
  // remainder so the row ends flush against the right inset.
  const width = Math.floor((usableWidth - totalGap) / count);
  return Array.from({ length: count }, (_, i) => {
    const isLast = i === count - 1;
    const x = originX + pad.left + i * (width + gap);
    return {
      x,
      y: originY + pad.top,
      width: isLast ? originX + pad.left + usableWidth - x : width,
      height: usableHeight,
    };
  });
}

module.exports = { computeLayout, PHONE_ASPECT };
