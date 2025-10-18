// api/proxy.js
const axios = require("axios");
const url = require("url");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") return res.status(200).end();

  const target = (req.query.url || "").toString().trim();
  const type = (req.query.type || "file").toString();
  if (!target) return res.status(400).json({ status: false, error: "Missing ?url=" });

  try {
    // validate URL
    const parsed = url.parse(target);
    if (!parsed.protocol || !/https?:/.test(parsed.protocol)) {
      return res.status(400).json({ status: false, error: "Invalid URL" });
    }

    // fetch as stream
    const resp = await axios.get(target, {
      responseType: "stream",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        Referer: "https://www.tiktok.com/"
      },
      timeout: 20000,
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400
    });

    // determine filename and content-type
    const ct = resp.headers["content-type"] || "application/octet-stream";
    let ext = "bin";
    if (ct.includes("video")) ext = "mp4";
    else if (ct.includes("audio")) ext = "mp3";
    else if (ct.includes("jpeg")) ext = "jpg";
    else if (ct.includes("png")) ext = "png";
    else if (ct.includes("webp")) ext = "webp";

    const filename = `${type || "file"}.${ext}`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", ct);
    // forward some cache headers optionally
    if (resp.headers["content-length"]) res.setHeader("Content-Length", resp.headers["content-length"]);

    // pipe stream
    resp.data.pipe(res);
    resp.data.on("end", () => res.end());
    resp.data.on("error", (e) => {
      console.error("stream error", e && e.message);
      try { res.end(); } catch (e) {}
    });
  } catch (err) {
    console.error(err && err.message);
    return res.status(500).json({ status: false, error: "Proxy fetch failed: " + (err && err.message) });
  }
};
