import axios from "axios";

async function tpost(schema) {
    const data = {};
    data.status = true;

    if (!schema.url) {
        data.status = false;
        data.error = "Please, provide a TikTok link!";
        return data;
    }

    let ifMobile = false;
    try {
        schema.url.split("vm.");
        ifMobile = true;
    } catch {
        try {
            schema.url.split("@");
            ifMobile = false;
        } catch {
            ifMobile = undefined;
        }
    }

    if (ifMobile === undefined) {
        data.status = false;
        data.error = "Input URL is not valid!";
        return data;
    }

    if (data.status) {
        try {
            // 🔹 SERVER 1
            const data2 = await axios.post("https://tikdown.org/getAjax", {
                url: schema.url,
                _token: schema.token,
            });
            data.server1 = {};
            data.server1.video = data2.data.html.split('<a class="button-primary w-button download-button"   href="')[1].split('"')[0];
            try {
                data.server1.music = data2.data.html.split('<a class="button-primary w-button download-button"  href="')[1].split('"')[0];
            } catch {
                data.server1.music = undefined;
            }

            // 🔹 SERVER 2
            let new_token = await axios.get("https://tiktokdownloader.one/", {
                headers: {
                    "user-agent":
                        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36",
                },
            });
            new_token = new_token.data.split('token_" content="')[1].split('"')[0];
            const tt_agent =
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.110 Safari/537.36";

            let af_url = schema.url.includes("?")
                ? schema.url.split("?")[0]
                : schema.url;

            let data4;
            data.server2 = {};
            try {
                data4 = await axios.get(
                    "https://tiktokdownloader.one/api/v1/fetch?url=" + af_url,
                    {
                        headers: {
                            token: new_token,
                            "user-agent": tt_agent,
                        },
                    }
                );

                data.server2 = data4.data;
                data4.data.id = data4.data.id.toString();
                data4.data.stats.comments = data4.data.stats.comments.toString();
                data4.data.stats.likes = data4.data.stats.likes.toString();
                data4.data.stats.play = data4.data.stats.play.toString();
                data4.data.stats.shares = data4.data.stats.shares.toString();

                const after_edit = [
                    data4.data.stats.likes,
                    data4.data.stats.comments,
                    data4.data.stats.play,
                    data4.data.stats.shares,
                ];

                data.server2.stats = {
                    likes: after_edit[0],
                    comments: after_edit[1],
                    views: after_edit[2],
                    shares: after_edit[3],
                };

                let popularity =
                    (after_edit[0] / after_edit[2]) *
                    ((after_edit[3] / after_edit[1]) * 10) *
                    10 *
                    10;
                if (popularity > 100) popularity = 100;
                if (isNaN(popularity)) popularity = 0;

                data.server2.stats.popularity = "%" + Math.floor(popularity).toString();

                data.server2.created_at = data4.data.uploaded_at;
                delete data.server2.share_url;
                delete data.server2.uploaded_at;
                delete data.server2.dl_count;
                delete data.server2.url_num;
                delete data.server2.url_nwm;
            } catch {
                data.server2 = undefined;
            }
        } catch (err) {
            data.status = false;
            data.error = "Failed to process TikTok URL!";
        }
    }
    return data;
}

async function tiktok(url) {
    const data = {};
    data.url = url;
    data.token = process.env.TIKTOK_TOKEN || "8Oz7BbSvJdKJpK7If78L0eD1fS6JdxtANu8LAuTh";
    const payload = await tpost(data);
    return payload;
}

// Handler untuk vercel
export default async function handler(req, res) {
    const { url } = req.query;

    if (!url || !url.includes("tiktok.com")) {
        return res.status(400).json({
            status: false,
            error: "Masukkan tautan TikTok yang valid!",
        });
    }

    try {
        const result = await tiktok(url);
        return res.status(200).json(result);
    } catch (err) {
        return res.status(500).json({
            status: false,
            error: "Terjadi kesalahan server: " + err.message,
        });
    }
                  }
