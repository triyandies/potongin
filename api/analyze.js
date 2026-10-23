const { YoutubeTranscript } = require("youtube-transcript");

function getVideoId(url) {
  const m = String(url).match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  return m ? m[1] : null;
}
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Gunakan metode POST." });
  const { url, count = 6, minLen = 20, maxLen = 60 } = req.body || {};
  const id = getVideoId(url);
  if (!id) return res.status(400).json({ error: "Link YouTube tidak valid." });
  if (!process.env.GEMINI_API_KEY)
    return res.status(500).json({ error: "GEMINI_API_KEY belum diatur di Vercel." });

  let items;
  try {
    items = await YoutubeTranscript.fetchTranscript(id);
  } catch (e) {
    return res.status(422).json({ error: "Transkrip video ini tidak tersedia (caption dimatikan, video privat, atau diblokir YouTube). Detail: " + (e && e.message ? e.message : e) });
  }
  if (!items.length) return res.status(422).json({ error: "Transkrip kosong." });

  const durs = items.map((i) => i.duration).sort((a, b) => a - b);
  const div = durs[Math.floor(durs.length / 2)] > 50 ? 1000 : 1;
  const lines = items.map((i) => `[${mmss(i.offset / div)}] ${i.text}`).join("\n").slice(0, 90000);
  const last = items[items.length - 1];
  const total = Math.ceil((last.offset + last.duration) / div);

  const prompt = `Kamu editor video Shorts profesional. Dari transkrip berikut (durasi video ${mmss(total)}), pilih maksimal ${count} momen terbaik untuk dijadikan klip vertikal.
Kriteria: ada hook kuat di 3 detik pertama, berdiri sendiri tanpa konteks tambahan, punya emosi/humor/insight/klimaks, dan selesai di akhir kalimat yang utuh.
Durasi tiap klip ${minLen}-${maxLen} detik. Klip tidak boleh saling tumpang tindih.
Balas HANYA JSON array tanpa teks lain, format:
[{"start": detik_mulai, "end": detik_selesai, "title": "judul pendek yang bikin penasaran", "reason": "alasan singkat momen ini kuat", "score": 1-100}]

Transkrip:
${lines}`;

  try {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-goog-api-key": process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            maxOutputTokens: 4000,
            thinkingConfig: { thinkingBudget: 0 },
          },
        }),
      }
    );
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: data?.error?.message || "Gagal menghubungi Gemini." });
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map((p) => p.text || "").join("");
    const clips = JSON.parse(text.replace(/```json|```/g, "").trim())
      .map((c) => ({
        start: Math.max(0, Math.floor(c.start)),
        end: Math.min(total, Math.ceil(c.end)),
        title: String(c.title || "Klip"),
        reason: String(c.reason || ""),
        score: Number(c.score) || 0,
      }))
      .filter((c) => c.end > c.start)
      .sort((a, b) => b.score - a.score);
    return res.status(200).json({ id, total, clips });
  } catch (e) {
    return res.status(500).json({ error: "Gagal memproses hasil AI. Coba lagi." });
  }
};
