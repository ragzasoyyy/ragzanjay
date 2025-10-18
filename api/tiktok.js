// api/tiktok.js
const axios = require("axios");

const DEFAULT_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0 Safari/537.36";

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}
function unescapeString(str) {
  if (!str) return str;
  return str.replace(/\\u002F/g, "/").replace(/\\\//g, "/").replace(/\\n/g, "").replace(/\\"/g, '"');
}
function extractMeta(html, name) {
  const re = new RegExp(`<meta[^>]*property=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
  const m = html.match(re);
  if (m && m[1]) return m[1];
  const re2 = new RegExp(`<meta[^>]*name=["']${name}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i");
  const m2 = html.match(re2);
  if (m2 && m2[1]) return m2[1];
  return null;
}
function tryExtractFromSIGI(html) {
  const sigiRe = /<script[^>]*id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i;
  const m = html.match(sigiRe);
  if (!m) return null;
  const parsed = safeJsonParse(m[1]);
  if (!parsed) return null;
  try {
    const itemModule = parsed.ItemModule;
    const userModule = parsed.UserModule;
    if (itemModule) {
      const keys = Object.keys(itemModule);
      if (keys.length) {
        const itm = itemModule[keys[0]];
        const video = (itm?.video?.downloadAddr) || (itm?.video?.playAddr) || (itm?.video?.playAddrLow);
        const cover = itm?.video?.cover || itm?.video?.originCover || itm?.video?.dynamicCover;
        const desc = itm?.desc || itm?.text;
        const authorMeta = itm?.author || itm?.authorMeta || itm?.authorName;
        // author avatar from userModule if present
        let avatar = null;
        try {
          const authorId = Object.keys(itemModule)[0];
          const authorUid = itm?.author; // sometimes username
          // try userModule.users
          if (userModule && userModule.users) {
            const users = userModule.users;
            // find user object by nickname or uid
            for (const k of Object.keys(users)) {
              const u = users[k];
              if (u && (u.nickname === authorMeta || u.uniqueId === authorMeta || k === authorMeta)) {
                avatar = u.avatarLarger || u.avatarMedium || u.avatarThumb;
                break;
              }
            }
          }
        } catch (e) {}
        const stats = itm?.stats || {};
        // music info
        const music = itm?.music || itm?.musicInfo || itm?.music_meta;
        return { video, cover, desc, author: authorMeta, avatar, stats, music };
      }
    }
  } catch (e) { return null; }
  return null;
}
function tryExtractFromJSONLD(html) {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const obj = safeJsonParse(m[1]);
    if (!obj) continue;
    if (obj && (obj["@type"] === "VideoObject" || obj.contentUrl)) {
      return {
        video: obj.contentUrl || obj.url || (obj.video && obj.video.contentUrl),
        cover: obj.thumbnailUrl || (obj.image && obj.image.url),
        desc: obj.description || obj.name,
        author: obj.author && (obj.author.name || obj.author["@id"]),
      };
    }
  }
  return null;
}
function tryExtractPlayAddr(html) {
  const re = /"(?:playAddr|downloadAddr)"\s*:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) return unescapeString(m[1]);
  }
  return null;
}
function findHashtags(text){
  if(!text) return [];
  const tags = text.match(/#([^\s#]+)/g) || [];
  return tags.map(t => t.trim());
}
function makeAbsoluteIfNeeded(url){
  if(!url) return url;
  if(url.startsWith("//")) return "https:" + url;
  if(url.startsWith("http")) return url;
  return url;
}
async function fetchHtml(targetUrl){
  const res = await axios.get(targetUrl, {
    headers: {
      "User-Agent": DEFAULT_UA,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Referer": "https://www.tiktok.com/",
      "Accept-Language": "en-US,en;q=0.9"
    },
    maxRedirects: 5,
    timeout: 10000,
    validateStatus: s => s >= 200 && s < 400
  });
  return { html: res.data, finalUrl: res.request?.res?.responseUrl || targetUrl, status: res.status };
}

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const q = (req.query.url || "").toString().trim();
  if (!q) return res.status(400).json({ status: false, error: "Please provide ?url=" });

  // follow short links if present
  let candidates = [q];
  if (/vt\.tiktok\.com|vm\.tiktok\.com|v\.tiktok\.com/.test(q)) {
    try {
      const head = await axios.get(q, { headers: { "User-Agent": DEFAULT_UA }, maxRedirects: 5, timeout: 8000, validateStatus: s => s>=200 && s<400 });
      const final = head.request?.res?.responseUrl;
      if(final && final !== q) candidates.unshift(final);
    } catch(e) { /* ignore */ }
  }

  let debug = { attempts: [] };
  let result = null;

  for (const candidate of candidates) {
    try {
      const { html, finalUrl, status } = await fetchHtml(candidate);
      debug.attempts.push({ candidate, finalUrl, status });

      // 1. OG meta
      const ogVideo = extractMeta(html, "og:video") || extractMeta(html, "og:video:secure_url") || extractMeta(html, "og:video:url");
      const ogImage = extractMeta(html, "og:image") || extractMeta(html, "twitter:image");
      const descMeta = extractMeta(html, "og:description") || extractMeta(html, "description") || null;
      if (ogVideo) {
        result = {
          status: true,
          video: makeAbsoluteIfNeeded(unescapeString(ogVideo)),
          cover: makeAbsoluteIfNeeded(ogImage),
          desc: descMeta,
          hashtags: findHashtags(descMeta),
          source: "og",
          debug
        };
        break;
      }

      // 2. JSON-LD
      const jsonld = tryExtractFromJSONLD(html);
      if (jsonld && jsonld.video) {
        result = {
          status: true,
          video: makeAbsoluteIfNeeded(unescapeString(jsonld.video)),
          cover: makeAbsoluteIfNeeded(jsonld.cover),
          desc: jsonld.desc,
          hashtags: findHashtags(jsonld.desc),
          author: jsonld.author,
          source: "jsonld",
          debug
        };
        break;
      }

      // 3. SIGI_STATE
      const sigi = (function(){
        const sigiRe = /<script[^>]*id=["']SIGI_STATE["'][^>]*>([\s\S]*?)<\/script>/i;
        const m = html.match(sigiRe);
        if (!m) return null;
        const parsed = safeJsonParse(m[1]);
        if(!parsed) return null;
        try {
          const itemModule = parsed.ItemModule;
          const userModule = parsed.UserModule;
          if(itemModule){
            const keys = Object.keys(itemModule);
            if(keys.length){
              const itm = itemModule[keys[0]];
              const video = itm?.video?.downloadAddr || itm?.video?.playAddr || itm?.video?.playAddrLow;
              const cover = itm?.video?.originCover || itm?.video?.dynamicCover || itm?.video?.cover;
              const desc = itm?.desc || itm?.text;
              const author = itm?.author || itm?.authorMeta || itm?.authorNickname;
              let avatar = null;
              if(userModule && userModule.users){
                for(const k of Object.keys(userModule.users)){
                  const u = userModule.users[k];
                  if(u && (u.nickname === author || u.uniqueId === author || k === author)){
                    avatar = u.avatarLarger || u.avatarMedium || u.avatarThumb;
                    break;
                  }
                }
              }
              const music = itm?.music || itm?.musicInfo || null;
              const stats = itm?.stats || {};
              return { video, cover, desc, author, avatar, music, stats };
            }
          }
        } catch(e) {}
        return null;
      })();

      if (sigi && (sigi.video || sigi.cover)) {
        result = {
          status: true,
          video: sigi.video ? makeAbsoluteIfNeeded(unescapeString(sigi.video)) : null,
          cover: makeAbsoluteIfNeeded(sigi.cover),
          desc: sigi.desc,
          hashtags: findHashtags(sigi.desc),
          author: sigi.author,
          avatar: makeAbsoluteIfNeeded(sigi.avatar),
          music: (function(){
            try {
              if(!sigi.music) return null;
              if (sigi.music.playUrl) return sigi.music.playUrl;
              if (sigi.music.playUrlHd) return sigi.music.playUrlHd;
              if (sigi.music && typeof sigi.music === "string") return sigi.music;
              return null;
            } catch(e) { return null; }
          })(),
          stats: sigi.stats || {},
          source: "SIGI_STATE",
          debug
        };
        break;
      }

      // 4. playAddr pattern
      const playAddr = tryExtractPlayAddr(html);
      if (playAddr) {
        result = {
          status: true,
          video: makeAbsoluteIfNeeded(playAddr),
          cover: makeAbsoluteIfNeeded(ogImage),
          desc: descMeta,
          hashtags: findHashtags(descMeta),
          source: "playAddr",
          debug
        };
        break;
      }

      // 5. mobile UA attempt
      try {
        const mobileRes = await axios.get(candidate, {
          headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15A372 Safari/604.1", "Referer":"https://www.tiktok.com/" },
          timeout: 10000,
          maxRedirects: 5,
          validateStatus: s => s >= 200 && s < 400
        });
        const htmlMobile = mobileRes.data;
        const mobileOg = extractMeta(htmlMobile, "og:video");
        const mobilePlay = (function(){
          const re = /"(?:playAddr|downloadAddr)"\s*:\s*"([^"]+)"/g;
          let m;
          while((m = re.exec(htmlMobile)) !== null) if(m[1]) return unescapeString(m[1]);
          return null;
        })();
        if(mobileOg || mobilePlay){
          result = {
            status: true,
            video: makeAbsoluteIfNeeded(unescapeString(mobileOg || mobilePlay)),
            cover: extractMeta(htmlMobile, "og:image"),
            desc: extractMeta(htmlMobile, "og:description"),
            hashtags: findHashtags(extractMeta(htmlMobile, "og:description")),
            source: "mobile",
            debug
          };
          break;
        }
      } catch(e) { /* ignore mobile attempt errors */ }

    } catch (e) {
      debug.attempts.push({ candidate, error: (e && e.message) || "fetch error" });
    }
  } // end for

  if (!result) {
    return res.status(500).json({ status: false, error: "Could not extract metadata from TikTok page.", debug });
  }

  // Detect photo-only: if video absent but cover present and cover likely image, treat as photo post
  const isPhoto = (!result.video && result.cover && /\.(jpg|jpeg|png|webp)/i.test(result.cover));

  return res.status(200).json({
    status: true,
    video: result.video || null,
    cover: result.cover || null,
    desc: result.desc || null,
    hashtags: result.hashtags || [],
    author: result.author || null,
    avatar: result.avatar || null,
    music: result.music || null,
    isPhoto,
    source: result.source || "heuristic",
    debug: (result.debug && result.debug.attempts) ? result.debug.attempts : undefined
  });
};
