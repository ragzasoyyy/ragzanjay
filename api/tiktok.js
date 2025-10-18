// api/tiktok.js
// Hybrid TikTok scraper for Vercel
const axios = require("axios");

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0 Safari/537.36";

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch (e) {
    return null;
  }
}

function unescapeString(str) {
  if (!str) return str;
  try {
    // Replace escaped slashes and unicode sequences
    return str.replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/\\n/g, "").replace(/\\"/g, '"');
  } catch (e) {
    return str;
  }
}

function extractMeta(html, name) {
  // name: og:video or og:image or description
  const re = new RegExp(`<meta[^>]*property=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
  const m = html.match(re);
  if (m && m[1]) return m[1];
  // try name attr variant
  const re2 = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
  const m2 = html.match(re2);
  if (m2 && m2[1]) return m2[1];
  return null;
}

function tryExtractFromSIGI(html) {
  // TikTok sometimes embeds a JSON in <script id="SIGI_STATE">...</script>
  const sigiRe = /<script[^>]*id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i;
  const m = html.match(sigiRe);
  if (!m) return null;
  const content = m[1];
  const parsed = safeJsonParse(content);
  if (!parsed) return null;
  // ItemModule path
  try {
    const itemModule = parsed?.ItemModule;
    if (itemModule) {
      const keys = Object.keys(itemModule);
      if (keys.length) {
        const itm = itemModule[keys[0]];
        const video = itm?.video?.downloadAddr || itm?.video?.playAddr || itm?.video?.playAddrLow;
        const cover = itm?.video?.cover || itm?.author?.avatarLarger || itm?.author?.avatarMedium;
        const desc = itm?.desc || itm?.text || itm?.title;
        const author = itm?.author || itm?.authorMeta || itm?.author_id || itm?.author?.nickname;
        const stats = itm?.stats || {};
        return { video, cover, desc, author, stats };
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

function tryExtractFromWindowData(html) {
  // Some pages include window['SIGI_STATE'] or <script>window['SIGI_STATE']=...;</script>
  const winRe = /window\[['"]SIGI_STATE['"]\]\s*=\s*({[\s\S]*?});/i;
  const m = html.match(winRe);
  if (!m) return null;
  const parsed = safeJsonParse(m[1]);
  if (!parsed) return null;
  try {
    const itemModule = parsed?.ItemModule;
    if (itemModule) {
      const keys = Object.keys(itemModule);
      if (keys.length) {
        const itm = itemModule[keys[0]];
        const video = itm?.video?.downloadAddr || itm?.video?.playAddr;
        const cover = itm?.video?.cover;
        const desc = itm?.desc;
        const author = itm?.author;
        return { video, cover, desc, author, stats: itm.stats || {} };
      }
    }
  } catch (e) {
    return null;
  }
  return null;
}

function tryExtractFromJSONLD(html) {
  // JSON-LD <script type="application/ld+json"> ... </script>
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const obj = safeJsonParse(m[1]);
    if (!obj) continue;
    if (obj && (obj["@type"] === "VideoObject" || obj.contentUrl)) {
      return {
        video: obj.contentUrl || obj.url || obj.video && obj.video.contentUrl,
        cover: obj.thumbnailUrl || (obj.image && obj.image.url),
        desc: obj.description || obj.name,
        author: obj.author && (obj.author.name || obj.author["@id"]),
      };
    }
  }
  return null;
}

function tryExtractPlayAddr(html) {
  // Try to find "playAddr":"https...mp4" or "downloadAddr":"https...mp4"
  const re = /"(?:playAddr|downloadAddr)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) {
      return unescapeString(m[1]);
    }
  }
  // alternative: data-video-url or og:video
  return null;
}

function makeAbsoluteIfNeeded(url) {
  if (!url) return url;
  if (url.startsWith("//")) return "https:" + url;
  if (url.startsWith("http")) return url;
  return url;
}

async function fetchHtml(targetUrl, opts = {}) {
  const headers = {
    "User-Agent": opts.ua || DEFAULT_UA,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.tiktok.com/",
    ...opts.extraHeaders,
  };

  const res = await axios.get(targetUrl, {
    headers,
    maxRedirects: 5,
    timeout: opts.timeout || 10000,
    validateStatus: (s) => s >= 200 && s < 400, // accept 3xx too to follow
  });
  return { html: res.data, finalUrl: res.request?.res?.responseUrl || targetUrl, status: res.status };
}

// Simple in-memory rate limiter (per IP) to avoid abuse (basic)
const RATE_LIMIT_WINDOW = 60 * 1000; // 60 sec
const RATE_LIMIT_MAX = 30; // max requests per window per IP
const ipStore = {};

function checkRateLimit(ip) {
  if (!ip) return true;
  const now = Date.now();
  if (!ipStore[ip]) ipStore[ip] = { ts: now, count: 1 };
  else {
    if (now - ipStore[ip].ts > RATE_LIMIT_WINDOW) {
      ipStore[ip] = { ts: now, count: 1 };
    } else {
      ipStore[ip].count++;
    }
  }
  return ipStore[ip].count <= RATE_LIMIT_MAX;
}

// Handler - CommonJS export so it can work on many Vercel setups
module.exports = async function handler(req, res) {
  try {
    res.setHeader("Content-Type", "application/json");
    // Basic CORS for frontend hosting same project
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
    if (req.method === "OPTIONS") return res.status(200).end();

    const ip = req.headers["x-forwarded-for"] || req.connection.remoteAddress;
    if (!checkRateLimit(ip)) {
      return res.status(429).json({ status: false, error: "Rate limit exceeded" });
    }

    const url = (req.query.url || "").toString().trim();
    if (!url) {
      return res.status(400).json({ status: false, error: "Please provide a TikTok URL via ?url=" });
    }

    // Normalize short vt.tiktok.com redirects by requesting once and following redirects
    let tryUrls = [url];
    // If vt.tiktok.com or vm.tiktok.com short link, request to follow redirect
    if (/vt\.tiktok\.com|vm\.tiktok\.com|v\.tiktok\.com/.test(url)) {
      try {
        const head = await axios.get(url, {
          headers: { "User-Agent": DEFAULT_UA },
          maxRedirects: 5,
          timeout: 8000,
          validateStatus: (s) => s >= 200 && s < 400,
        });
        const final = head.request?.res?.responseUrl;
        if (final) tryUrls.unshift(final);
      } catch (e) {
        // ignore redirect failure, still try original
      }
    }

    let finalResult = null;
    let debug = { attempts: [] };

    // Try multiple strategies in order for each candidate URL
    for (const candidate of tryUrls) {
      try {
        // Try desktop UA first
        const { html, finalUrl, status } = await fetchHtml(candidate, { ua: DEFAULT_UA, timeout: 10000 });
        debug.attempts.push({ candidate, finalUrl, status });

        // 1) try og meta
        const ogVideo = extractMeta(html, "og:video") || extractMeta(html, "og:video:secure_url") || extractMeta(html, "og:video:url");
        const ogImage = extractMeta(html, "og:image") || extractMeta(html, "twitter:image");
        const descMeta = extractMeta(html, "og:description") || extractMeta(html, "description");

        if (ogVideo) {
          finalResult = {
            status: true,
            source: "meta-og",
            video: makeAbsoluteIfNeeded(unescapeString(ogVideo)),
            cover: makeAbsoluteIfNeeded(unescapeString(ogImage)),
            desc: descMeta,
            raw: null,
            debug,
          };
          break;
        }

        // 2) try JSON-LD
        const jsonld = tryExtractFromJSONLD(html);
        if (jsonld && jsonld.video) {
          finalResult = {
            status: true,
            source: "json-ld",
            video: makeAbsoluteIfNeeded(unescapeString(jsonld.video)),
            cover: makeAbsoluteIfNeeded(unescapeString(jsonld.cover)),
            desc: jsonld.desc,
            author: jsonld.author,
            raw: null,
            debug,
          };
          break;
        }

        // 3) try SIGI_STATE or window['SIGI_STATE']
        const sigi = tryExtractFromSIGI(html) || tryExtractFromWindowData(html);
        if (sigi && sigi.video) {
          const v = unescapeString(sigi.video);
          finalResult = {
            status: true,
            source: "SIGI_STATE",
            video: makeAbsoluteIfNeeded(v),
            cover: makeAbsoluteIfNeeded(unescapeString(sigi.cover)),
            desc: sigi.desc,
            author: sigi.author,
            stats: sigi.stats || {},
            raw: null,
            debug,
          };
          break;
        }

        // 4) try playAddr/downloadAddr pattern
        const playAddr = tryExtractPlayAddr(html);
        if (playAddr) {
          finalResult = {
            status: true,
            source: "playAddr-pattern",
            video: makeAbsoluteIfNeeded(unescapeString(playAddr)),
            cover: makeAbsoluteIfNeeded(ogImage),
            desc: descMeta,
            debug,
          };
          break;
        }

        // 5) try mobile UA (some endpoints return different HTML)
        const { html: htmlMobile } = await fetchHtml(candidate, { ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15A372 Safari/604.1", timeout: 10000 });
        debug.attempts.push({ candidate, finalUrl: candidate, status: "mobile-try" });

        const mobileOg = extractMeta(htmlMobile, "og:video") || extractMeta(htmlMobile, "og:video:secure_url");
        if (mobileOg) {
          finalResult = {
            status: true,
            source: "mobile-og",
            video: makeAbsoluteIfNeeded(unescapeString(mobileOg)),
            cover: extractMeta(htmlMobile, "og:image"),
            debug,
          };
          break;
        }

        const mobilePlay = tryExtractPlayAddr(htmlMobile);
        if (mobilePlay) {
          finalResult = {
            status: true,
            source: "mobile-playAddr",
            video: makeAbsoluteIfNeeded(unescapeString(mobilePlay)),
            debug,
          };
          break;
        }

        // no extraction from this candidate; continue to next candidate if any
      } catch (e) {
        debug.attempts.push({ candidate, error: (e && e.message) || "fetch error" });
        // continue with next candidate
      }
    } // end for candidates

    if (!finalResult) {
      return res.status(500).json({
        status: false,
        error: "Could not extract video URL using heuristics.",
        debug,
      });
    }

    // Success
    return res.status(200).json({
      status: true,
      video: finalResult.video,
      cover: finalResult.cover || null,
      desc: finalResult.desc || null,
      author: finalResult.author || null,
      source: finalResult.source || "unknown",
      debug: finalResult.debug || undefined,
    });
  } catch (err) {
    return res.status(500).json({
      status: false,
      error: "Server error: " + (err && err.message),
    });
  }
};
