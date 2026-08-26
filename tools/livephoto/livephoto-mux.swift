// livephoto-mux.swift — Kodlanmış videoyu + şablon metadata kanallarını
//                       tek bir Live Photo MOV'una birleştirir, HEIC kapağı yazar.
//
//   swift livephoto-mux.swift <kapak.jpg> <video.mov> <metadata.mov> <cikti.heic> <cikti.mov>
//
// apple-livephoto-generator.swift'in yerine geçiyor. Tek farkı dayanıklılık:
// yeni macOS sürümlerinde AVAssetTrack.formatDescriptions senkron erişimde boş
// dönebiliyor ve eski araç orada "Cannot read source video format" diye
// duruyordu. Burada format ipucu zorunlu değil — yoksa AVAssetWriter ilk
// örnekten kendisi çıkarıyor.
//
// Yapılan işler:
//   • video örnekleri passthrough kopyalanır (yeniden kodlama YOK)
//   • şablondaki Apple metadata kanalları aynen taşınır
//   • MOV'a com.apple.quicktime.content.identifier yazılır
//   • HEIC'e aynı kimlik Apple maker note anahtar 17 olarak yazılır
//
// Metadata şablonu apple-video-to-livephotos (MIT) projesinden.

import Foundation
import AVFoundation
import CoreMedia
import ImageIO
import UniformTypeIdentifiers

func fail(_ message: String, _ code: Int32) -> Never {
    FileHandle.standardError.write(Data("livephoto-mux: \(message)\n".utf8))
    exit(code)
}

let args = CommandLine.arguments
guard args.count == 6 else {
    fail("Kullanım: swift livephoto-mux.swift <kapak> <video.mov> <metadata.mov> <cikti.heic> <cikti.mov>", 64)
}

let stillURL = URL(fileURLWithPath: args[1])
let videoURL = URL(fileURLWithPath: args[2])
let metaURL  = URL(fileURLWithPath: args[3])
let outHEIC  = URL(fileURLWithPath: args[4])
let outMOV   = URL(fileURLWithPath: args[5])

for url in [stillURL, videoURL, metaURL] {
    guard FileManager.default.fileExists(atPath: url.path) else {
        fail("dosya yok: \(url.path)", 1)
    }
}

let identifier = UUID().uuidString

// MARK: - Kapak: HEIC + Apple maker note

func writeStill() {
    guard let source = CGImageSourceCreateWithURL(stillURL as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fail("kapak karesi okunamadı", 2)
    }
    var props = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]) ?? [:]
    var maker = (props[kCGImagePropertyMakerAppleDictionary] as? [String: Any]) ?? [:]
    maker["17"] = identifier                  // Content Identifier — MOV ile eşleşen bağ
    maker["15"] = UUID().uuidString           // Photo Identifier
    if maker["14"] == nil { maker["14"] = 10 } // Image Capture Type
    props[kCGImagePropertyMakerAppleDictionary] = maker
    props[kCGImageDestinationLossyCompressionQuality] = 1.0

    try? FileManager.default.removeItem(at: outHEIC)
    let type = outHEIC.pathExtension.lowercased() == "heic"
        ? UTType.heic.identifier : UTType.jpeg.identifier
    guard let dest = CGImageDestinationCreateWithURL(outHEIC as CFURL, type as CFString, 1, nil) else {
        fail("HEIC oluşturulamadı", 3)
    }
    CGImageDestinationAddImage(dest, image, props as CFDictionary)
    guard CGImageDestinationFinalize(dest) else { fail("HEIC yazılamadı", 4) }
}

// MARK: - Video + metadata birleştirme

func writeMovie() {
    let video = AVURLAsset(url: videoURL)
    let meta  = AVURLAsset(url: metaURL)

    guard let videoTrack = video.tracks(withMediaType: .video).first else {
        fail("videoda görüntü akışı yok", 5)
    }
    let metaTracks = meta.tracks(withMediaType: .metadata)
    guard !metaTracks.isEmpty else { fail("şablonda metadata kanalı yok", 6) }

    try? FileManager.default.removeItem(at: outMOV)
    guard let writer = try? AVAssetWriter(outputURL: outMOV, fileType: .mov),
          let videoReader = try? AVAssetReader(asset: video),
          let metaReader = try? AVAssetReader(asset: meta) else {
        fail("okuyucu/yazıcı kurulamadı", 7)
    }

    // Kimlik — MOV tarafındaki bağ
    let idItem = AVMutableMetadataItem()
    idItem.keySpace = .quickTimeMetadata
    idItem.key = "com.apple.quicktime.content.identifier" as NSString
    idItem.value = identifier as NSString
    writer.metadata = [idItem]

    // Görüntü: sıkıştırılmış örnekler olduğu gibi taşınır
    let videoOut = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: nil)
    videoOut.alwaysCopiesSampleData = false
    guard videoReader.canAdd(videoOut) else { fail("görüntü okunamadı", 8) }
    videoReader.add(videoOut)

    // Format ipucu varsa kullan; yoksa yazıcı ilk örnekten çıkarsın.
    // (Yeni macOS'ta formatDescriptions senkron erişimde boş dönebiliyor —
    //  eski araç tam burada duruyordu.)
    let hint = videoTrack.formatDescriptions.first.map { $0 as! CMFormatDescription }
    let videoIn = AVAssetWriterInput(mediaType: .video, outputSettings: nil, sourceFormatHint: hint)
    videoIn.expectsMediaDataInRealTime = false
    videoIn.transform = videoTrack.preferredTransform      // dikey video yan yatmasın
    guard writer.canAdd(videoIn) else { fail("görüntü yazıcısı eklenemedi", 9) }
    writer.add(videoIn)

    // Metadata kanalları
    var pairs: [(AVAssetWriterInput, AVAssetReaderTrackOutput)] = []
    for track in metaTracks {
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        guard metaReader.canAdd(out) else { continue }
        metaReader.add(out)
        let input = AVAssetWriterInput(mediaType: .metadata, outputSettings: nil)
        input.expectsMediaDataInRealTime = false
        guard writer.canAdd(input) else { fail("metadata kanalı eklenemedi", 10) }
        writer.add(input)
        pairs.append((input, out))
    }
    guard !pairs.isEmpty else { fail("metadata kanalı kurulamadı", 11) }

    guard videoReader.startReading() else {
        fail("video okuma başlamadı: \(videoReader.error?.localizedDescription ?? "?")", 12)
    }
    guard metaReader.startReading() else {
        fail("metadata okuma başlamadı: \(metaReader.error?.localizedDescription ?? "?")", 13)
    }
    guard writer.startWriting() else {
        fail("yazma başlamadı: \(writer.error?.localizedDescription ?? "?")", 14)
    }
    writer.startSession(atSourceTime: .zero)

    // Tüm kanallar AYNI ANDA beslenmeli — sırayla doldurmak kuyruğu taşırıyor
    final class Cursor { var done = false; var count = 0 }
    let group = DispatchGroup()

    let videoCursor = Cursor()
    group.enter()
    videoIn.requestMediaDataWhenReady(on: DispatchQueue(label: "lp.video")) {
        if videoCursor.done { return }
        while videoIn.isReadyForMoreMediaData {
            guard let sample = videoOut.copyNextSampleBuffer() else {
                videoCursor.done = true; videoIn.markAsFinished(); group.leave(); return
            }
            if !videoIn.append(sample) {
                videoCursor.done = true; videoIn.markAsFinished(); group.leave(); return
            }
            videoCursor.count += 1
        }
    }

    var metaCursors: [Cursor] = []
    for (index, pair) in pairs.enumerated() {
        let (input, output) = pair
        let cursor = Cursor()
        metaCursors.append(cursor)
        group.enter()
        input.requestMediaDataWhenReady(on: DispatchQueue(label: "lp.meta\(index)")) {
            if cursor.done { return }
            while input.isReadyForMoreMediaData {
                guard let sample = output.copyNextSampleBuffer() else {
                    cursor.done = true; input.markAsFinished(); group.leave(); return
                }
                if !input.append(sample) {
                    cursor.done = true; input.markAsFinished(); group.leave(); return
                }
                cursor.count += 1
            }
        }
    }

    group.wait()

    if videoReader.status == .failed {
        fail("video okuma hatası: \(videoReader.error?.localizedDescription ?? "?")", 15)
    }

    let done = DispatchSemaphore(value: 0)
    writer.finishWriting { done.signal() }
    done.wait()
    guard writer.status == .completed else {
        fail("yazma tamamlanamadı: \(writer.error?.localizedDescription ?? "?")", 16)
    }

    let metaCounts = metaCursors.map { String($0.count) }.joined(separator: "+")
    FileHandle.standardError.write(Data(
        "livephoto-mux: \(videoCursor.count) kare · metadata \(metaCounts) örnek · \(identifier)\n".utf8))
}

writeStill()
writeMovie()
print(identifier)
