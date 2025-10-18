import axios from "axios";

async function getTikdown(schema) {
  try {
    const res = await axios.post("https://tikdown.org/getAjax", {
      url: schema.url,
      _token: schema.token,
    }, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0 Safari/537.36",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 8000,
    });

    if (!res.data.html.includes("download-button"))
      throw new Error("Tikdown HTML invalid");

    const html = res.data.html;
    const video = html.split('href="')[1].split('"')[0];
    const music = html.includes('href="') ? html.split('href="')[2]?.split('"')[0] : null;

    return {
      status: true,
      server: "tikdown.org",
      video,
      music,
    };
  } catch (err) {
    return { status: false, error: "Tikdown error: " + err.message };
  }
}

async function getTikTokDownloader(url) {
  try {
    const tokenPage = await axios.get("https://tiktokdownloader.one/", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0 Safari/537.36",
      },
      timeout: 8000,
    });
    const token = tokenPage.data.split('token_" content="')[1].split('"')[0];

    const cleanUrl = url.includes("?") ? url.split("?")[0] : url;
    const res = await axios.get(
      `https://tiktokdownloader.one/api/v1/fetch?url=${encodeURIComponent(cleanUrl)}`,
      {
        headers: {
          token,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0 Safari/537.36",
        },
        timeout: 10000,
      }
    );

    const data = res.data;
    if (!data?.url?.nwm && !data?.url?.wm)
      throw new Error("Invalid response from tiktokdownloader.one");

    const stats = data.stats || {};
    let pop =
      ((stats.likes / stats.play) *
        ((stats.shares / stats.comments) * 10) *
        10 *
        10) || 0;
    if (pop > 100) pop = 100;
    if (isNaN(pop)) pop = 0;

    return {
      status: true,
      server: "tiktokdownloader.one",
      video: data.url.nwm || data.url.wm,
      music: data.music,
      author: data.author,
      desc: data.title,
      stats: {
        likes: stats.likes,
        comments: stats.comments,
        views: stats.play,
        shares: stats.shares,
        popularity: "%" + Math.floor(pop),
      },
    };
  } catch (err) {
    return { status: false, error: "TikTokDownloader error: " + err.message };
  }
}

export default async function handler(req, res) {
  const { url } = req.query;
  const token = process.env.TIKTOK_TOKEN || "8Oz7BbSvJdKJpK7If78L0eD1fS6JdxtANu8LAuTh";

  if (!url || !url.includes("tiktok.com")) {
    return res.status(400).json({
      status: false,
      error: "Masukkan tautan TikTok yang valid!",
    });
  }

  try {
    // Coba server1
    const server1 = await getTikdown({ url, token });
    if (server1.status) {
      return res.status(200).json({
        status: true,
        source: server1.server,
        video: server1.video,
        music: server1.music,
      });
    }

    // Coba server2
    const server2 = await getTikTokDownloader(url);
    if (server2.status) {
      return res.status(200).json({
        status: true,
        source: server2.server,
        video: server2.video,
        music: server2.music,
        author: server2.author,
        desc: server2.desc,
        stats: server2.stats,
      });
    }

    return res.status(500).json({
      status: false,
      error: "Kedua server gagal.\nServer1: " + server1.error + "\nServer2: " + server2.error,
    });
  } catch (err) {
    return res.status(500).json({
      status: false,
      error: "Server error: " + err.message,
    });
  }
}
