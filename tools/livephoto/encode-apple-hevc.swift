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
            return "Usage: swift encode-apple-hevc.swift <input.mov> <output.mov> [bitrate] [keyframe-interval] [10bit]"
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
let use10Bit = arguments.count == 6 && arguments[5].lowercased() == "10bit"

let asset = AVURLAsset(url: inputURL)
guard let sourceTrack = asset.tracks(withMediaType: .video).first else {
    throw EncodeError.missingVideoTrack
}

try? FileManager.default.removeItem(at: outputURL)
let reader = try AVAssetReader(asset: asset)
let readerOutput = AVAssetReaderTrackOutput(track: sourceTrack, outputSettings: [
    kCVPixelBufferPixelFormatTypeKey as String: Int(
        use10Bit
            ? kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange
            : kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    )
])
readerOutput.alwaysCopiesSampleData = false
guard reader.canAdd(readerOutput) else { throw EncodeError.cannotStart("Cannot read the source video.") }
reader.add(readerOutput)

let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mov)
let width = Int(sourceTrack.naturalSize.width.rounded())
let height = Int(sourceTrack.naturalSize.height.rounded())
let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: [
    AVVideoCodecKey: AVVideoCodecType.hevc,
    AVVideoWidthKey: width,
    AVVideoHeightKey: height,
    AVVideoCompressionPropertiesKey: [
        AVVideoAverageBitRateKey: bitrate,
        AVVideoExpectedSourceFrameRateKey: 60,
        AVVideoMaxKeyFrameIntervalKey: keyframeInterval,
        AVVideoProfileLevelKey: use10Bit
            ? kVTProfileLevel_HEVC_Main10_AutoLevel
            : kVTProfileLevel_HEVC_Main_AutoLevel
    ]
])
writerInput.expectsMediaDataInRealTime = false
guard writer.canAdd(writerInput) else { throw EncodeError.cannotStart("Cannot write the HEVC video.") }
writer.add(writerInput)

guard reader.startReading() else {
    throw EncodeError.cannotStart(reader.error?.localizedDescription ?? "Could not start reading.")
}
guard writer.startWriting() else {
    throw EncodeError.cannotStart(writer.error?.localizedDescription ?? "Could not start writing.")
}
writer.startSession(atSourceTime: .zero)

while let sample = readerOutput.copyNextSampleBuffer() {
    while !writerInput.isReadyForMoreMediaData {
        Thread.sleep(forTimeInterval: 0.001)
    }
    guard writerInput.append(sample) else {
        throw EncodeError.writeFailed(writer.error?.localizedDescription ?? "Could not append a video frame.")
    }
}

writerInput.markAsFinished()
let finished = DispatchSemaphore(value: 0)
writer.finishWriting { finished.signal() }
finished.wait()

guard writer.status == .completed else {
    throw EncodeError.writeFailed(writer.error?.localizedDescription ?? "HEVC export failed.")
}

print(outputURL.path)
