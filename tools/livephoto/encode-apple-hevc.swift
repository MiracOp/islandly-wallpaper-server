// encode-apple-hevc.swift — Videoyu Apple'ın kendi kodlayıcısıyla HEVC'ye çevirir.
//
//   swift encode-apple-hevc.swift <girdi> <cikti.mov> [bitrate] [keyframe] [bitdepth]
//
// Varsayılan: 4 Mbps · 60 kare ana kare aralığı · 10-bit (Main 10)
//
// NEDEN 10-BIT:
// Main 10 profili bant geçişlerini (gradient banding) belirgin azaltıyor —
// koyu gökyüzü, duman, degrade arka planlar 8-bit'te şeritleniyor. Kaynak
// 8-bit olsa bile kodlayıcı 10-bit'e çıkarken kuantalama hatası azalıyor,
// yani aynı bit hızında görüntü daha temiz kalıyor. iOS'un kendi kamerası da
// HDR çekimlerde Main 10 kullanıyor, format tanıdık.
//
// NEDEN 4 Mbps:
// Kameradan çıkan gerçek Live Photo ~3.9 Mbps. Daha yüksek bit hızlarında
// iOS kilit ekranı duvar kağıdı olarak kabul etmiyor.

import AVFoundation
import CoreVideo
import Foundation
import VideoToolbox

enum EncodeError: LocalizedError {
    case usage
    case missingVideoTrack
    case cannotStart(String)
    case writeFailed(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: swift encode-apple-hevc.swift <input> <output.mov> [bitrate] [keyframe-interval] [bitdepth 8|10]"
        case .missingVideoTrack:
            return "The input movie has no video track."
        case .cannotStart(let message), .writeFailed(let message):
            return message
        }
    }
}

let arguments = CommandLine.arguments
guard (3...6).contains(arguments.count) else { throw EncodeError.usage }

let inputURL = URL(fileURLWithPath: arguments[1])
let outputURL = URL(fileURLWithPath: arguments[2])
let bitrate = arguments.count >= 4 ? Int(arguments[3]) ?? 4_000_000 : 4_000_000
let keyframeInterval = arguments.count >= 5 ? Int(arguments[4]) ?? 60 : 60
let bitDepth = arguments.count >= 6 ? Int(arguments[5]) ?? 10 : 10
let wants10Bit = bitDepth >= 10

let asset = AVURLAsset(url: inputURL)
guard let sourceTrack = asset.tracks(withMediaType: .video).first else {
    throw EncodeError.missingVideoTrack
}

try? FileManager.default.removeItem(at: outputURL)
let reader = try AVAssetReader(asset: asset)

// 10-bit çıktı için kareleri de 10-bit olarak çözmek gerekiyor; kaynak 8-bit
// olsa bile AVAssetReader dönüştürüyor.
let pixelFormat = wants10Bit
    ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
    : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange

func makeOutput(_ format: OSType) -> AVAssetReaderTrackOutput {
    let out = AVAssetReaderTrackOutput(track: sourceTrack, outputSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: Int(format)
    ])
    out.alwaysCopiesSampleData = false
    return out
}

var readerOutput = makeOutput(pixelFormat)
var effective10Bit = wants10Bit
if !reader.canAdd(readerOutput) {
    // 10-bit çözme desteklenmiyorsa 8-bit'e düş — üretim durmasın
    effective10Bit = false
    readerOutput = makeOutput(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
    guard reader.canAdd(readerOutput) else {
        throw EncodeError.cannotStart("Cannot read the source video.")
    }
}
reader.add(readerOutput)

let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
let width = Int(sourceTrack.naturalSize.width.rounded())
let height = Int(sourceTrack.naturalSize.height.rounded())

var compression: [String: Any] = [
    AVVideoAverageBitRateKey: bitrate,
    AVVideoExpectedSourceFrameRateKey: 60,
    AVVideoMaxKeyFrameIntervalKey: keyframeInterval
]
if effective10Bit {
    compression[AVVideoProfileLevelKey] = kVTProfileLevel_HEVC_Main10_AutoLevel
}

func makeInput(_ props: [String: Any]) -> AVAssetWriterInput {
    let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
        AVVideoCodecKey: AVVideoCodecType.hevc,
        AVVideoWidthKey: width,
        AVVideoHeightKey: height,
        AVVideoCompressionPropertiesKey: props
    ])
    input.expectsMediaDataInRealTime = false
    return input
}

var writerInput = makeInput(compression)
if !writer.canAdd(writerInput) {
    // Main 10 kabul edilmediyse profil belirtmeden dene
    compression.removeValue(forKey: AVVideoProfileLevelKey)
    effective10Bit = false
    writerInput = makeInput(compression)
    guard writer.canAdd(writerInput) else {
        throw EncodeError.cannotStart("Cannot write the HEVC video.")
    }
}
writer.add(writerInput)

// Yönelim matrisi korunmalı — yoksa dikey video yan yatıyor
writerInput.transform = sourceTrack.preferredTransform

guard reader.startReading() else {
    throw EncodeError.cannotStart(reader.error?.localizedDescription ?? "Could not start reading.")
}
guard writer.startWriting() else {
    throw EncodeError.cannotStart(writer.error?.localizedDescription ?? "Could not start writing.")
}
writer.startSession(atSourceTime: .zero)

var frames = 0
while let sample = readerOutput.copyNextSampleBuffer() {
    while !writerInput.isReadyForMoreMediaData {
        Thread.sleep(forTimeInterval: 0.001)
    }
    guard writerInput.append(sample) else {
        throw EncodeError.writeFailed(writer.error?.localizedDescription ?? "Could not append a video frame.")
    }
    frames += 1
}

writerInput.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()

guard writer.status == .completed else {
    throw EncodeError.writeFailed(writer.error?.localizedDescription ?? "HEVC export failed.")
}

FileHandle.standardError.write(Data(
    "encode-apple-hevc: \(frames) kare · \(width)x\(height) · \(effective10Bit ? "10-bit Main 10" : "8-bit Main") · \(bitrate / 1_000_000) Mbps\n".utf8))
print(outputURL.path)
