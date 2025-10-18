const axios = require("axios");

module.exports = async function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ status: false, error: "Please provide a TikTok link!" });
  }

  try {
    // Server 1 - Tikdown
    const data1 = await axios.post("https://tikdown.org/getAjax", {
      url: url,
      _token: "8Oz7BbSvJdKJpK7If78L0eD1fS6JdxtANu8LAuTh"
    });

    const videoUrl = data1.data.html.split('href="')[1].split('"')[0];
    const musicUrl = data1.data.html.split('href="')[2]?.split('"')[0] || null;

    // Server 2 - tiktokdownloader.one
    const getToken = await axios.get("https://tiktokdownloader.one/", {
      headers: { "user-agent": "Mozilla/5.0" }
    });

    const token = getToken.data.split('token_" content="')[1].split('"')[0];
    const response = await axios.get(`https://tiktokdownloader.one/api/v1/fetch?url=${url}`, {
      headers: { token, "user-agent": "Mozilla/5.0" }
    });

    const server2 = response.data;

    return res.status(200).json({
      status: true,
      server1: {
        video: videoUrl,
        music: musicUrl
      },
      server2
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({
      status: false,
      error: "Failed to process TikTok URL!",
      detail: err.message
    });
  }
};
