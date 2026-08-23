# Islandly Live Photo üreticisi

Bu araç bir videoyu iOS kilit ekranı için kullanılan sıkı Live Photo profiline dönüştürür:

- 1080 × 1920 HEVC (`hvc1`)
- 60 fps, tam 55 kare (`550/600` saniye)
- HEIC ana kare
- Kamera kökenli `Live Photo Info` ve `still-image-time` metadata kanalları
- HEIC ve MOV içinde eşleşen benzersiz içerik kimliği

## Kullanım

macOS üzerinde FFmpeg, ExifTool ve Xcode/Swift gerektirir.

```bash
cd tools/livephoto
./canli-duvar-kagidi.sh /video/yolu/video.mp4 duvar-kagidi-adi
```

Başlangıç zamanı isteğe bağlı üçüncü argümandır:

```bash
./canli-duvar-kagidi.sh video.mp4 duvar-kagidi-adi 4.5
```

Çıktılar `cikti/` klasörüne yazılır. Oluşan `.heic`, `.mov` ve `-thumb.jpg` dosyalarını `public/media/` altına taşıyıp `data/wallpapers.json` kaydına bağlayın.

Metadata üreticisi `apple-video-to-livephotos` projesinden MIT lisansı altında uyarlanmıştır. Copyright © 2026 Teuku Fadhlul.
