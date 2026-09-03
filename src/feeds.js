'use strict';

const crypto = require('node:crypto');

// The whole surface area of this tool: three URLs. We open them in a browser
// window and get out of the way — nothing is scraped, logged in to, or
// automated on the user's behalf.
const FEEDS = {
  tiktok: {
    label: 'TikTok',
    url: 'https://www.tiktok.com/foryou',
  },
  instagram: {
    label: 'Instagram Reels',
    url: 'https://www.instagram.com/reels/',
  },
  youtube: {
    label: 'YouTube Shorts',
    url: 'https://www.youtube.com/shorts/',
  },
  twitch: {
    label: 'Twitch',
    url: 'https://www.twitch.tv/directory',
  },
  x: {
    label: 'X',
    url: 'https://x.com/home',
  },
  reddit: {
    label: 'Reddit',
    url: 'https://www.reddit.com/r/all/',
  },
};

function slugify(value) {
  return value.replace(/[^a-z0-9]+/gi, '-').toLowerCase().replace(/^-+|-+$/g, '') || 'feed';
}

// A feed spec is either a key from the table above or a bare URL, so
// `white-python open --feeds tiktok,https://news.ycombinator.com` works.
function resolveFeed(spec) {
  if (FEEDS[spec]) return { key: spec, ...FEEDS[spec] };
  if (/^https?:\/\//i.test(spec)) {
    let label = spec;
    try {
      const url = new URL(spec);
      const host = url.hostname.replace(/^www\./, '');
      const path = url.pathname.replace(/\/$/, '');
      label = host + path;
    } catch {
      /* keep the raw spec as the label */
    }
    // The key names this feed's browser profile directory, and two feeds
    // sharing a profile end up in one browser process — which lands both
    // windows in the same place. A hostname alone is not unique enough
    // (youtube.com/shorts and youtube.com/@someone would collide), so the key
    // carries a digest of the whole URL.
    const digest = crypto.createHash('sha1').update(spec).digest('hex').slice(0, 8);
    return { key: `${slugify(label)}-${digest}`, label, url: spec };
  }
  throw new Error(
    `Unknown feed "${spec}". Known feeds: ${Object.keys(FEEDS).join(', ')} (or pass a full https:// URL).`
  );
}

/**
 * Resolve a list of feed specs, guaranteeing distinct keys.
 *
 * Even with per-URL digests, the same feed listed twice would still collide —
 * and a shared profile directory silently collapses two windows into one. The
 * suffix keeps each window its own browser process.
 */
function resolveFeeds(specs) {
  const seen = new Map();
  return specs.map(resolveFeed).map((feed) => {
    const count = seen.get(feed.key) || 0;
    seen.set(feed.key, count + 1);
    return count === 0 ? feed : { ...feed, key: `${feed.key}-${count + 1}` };
  });
}

module.exports = { FEEDS, resolveFeed, resolveFeeds };
