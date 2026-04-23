import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import multer from "multer";
import ffmpeg from "fluent-ffmpeg";
import fs from "fs";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  const upload = multer({ dest: "uploads/" });

  // API for Transcoding WebM to MP4
  app.post("/api/transcode", upload.single("video"), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No video file provided" });
    }

    const { bitrate, fps, scale } = req.body;
    const inputPath = req.file.path;
    const outputPath = `${inputPath}.mp4`;

    let command = ffmpeg(inputPath)
      .outputOptions("-c:v libx264")
      .outputOptions("-preset fast")
      .outputOptions("-crf 22")
      .outputOptions("-c:a aac")
      .outputOptions("-b:a 128k")
      .outputOptions("-movflags +faststart");

    if (bitrate) {
      command = command.videoBitrate(`${bitrate}k`);
    }
    if (fps) {
      command = command.fps(parseInt(fps));
    }
    // Scaling is handled on client canvas side for better results, 
    // but server can also scale if needed for final file size reduction.

    command
      .toFormat("mp4")
      .on("end", () => {
        res.download(outputPath, "merged_video.mp4", (err) => {
          // Cleanup
          fs.unlinkSync(inputPath);
          if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        });
      })
      .on("error", (err) => {
        console.error("FFmpeg error:", err);
        res.status(500).json({ error: "Transcoding failed" });
        // Cleanup input
         if (fs.existsSync(inputPath)) fs.unlinkSync(inputPath);
      })
      .save(outputPath);
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
