import AVFoundation
import Foundation

enum StretchError: LocalizedError {
    case usage
    case noMetadata
    case exportUnavailable
    case exportFailed(String)

    var errorDescription: String? {
        switch self {
        case .usage:
            return "Usage: swift stretch-metadata.swift <input.mov> <output.mov> <seconds> [still-seconds] [fps]"
        case .noMetadata:
            return "The template does not contain both Apple metadata tracks."
        case .exportUnavailable:
            return "A passthrough metadata export session could not be created."
        case .exportFailed(let detail):
            return "Metadata export failed: \(detail)"
        }
    }
}

func loadMetadataTracks(_ asset: AVAsset) throws -> [AVAssetTrack] {
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<[AVAssetTrack], Error>!
    asset.loadTracks(withMediaType: .metadata) { tracks, error in
        if let error {
            result = .failure(error)
        } else {
            result = .success(tracks ?? [])
        }
        semaphore.signal()
    }
    semaphore.wait()
    return try result.get()
}

func export(_ composition: AVComposition, to output: URL) throws {
    guard let session = AVAssetExportSession(
        asset: composition,
        presetName: AVAssetExportPresetPassthrough
    ) else {
        throw StretchError.exportUnavailable
    }
    session.outputURL = output
    session.outputFileType = .mov

    let semaphore = DispatchSemaphore(value: 0)
    session.exportAsynchronously { semaphore.signal() }
    semaphore.wait()

    guard session.status == .completed else {
        throw StretchError.exportFailed(session.error?.localizedDescription ?? "unknown error")
    }
}

do {
    let args = CommandLine.arguments
    guard (4...6).contains(args.count),
          let seconds = Double(args[3]), seconds > 0 else {
        throw StretchError.usage
    }
    let stillSeconds: Double
    if args.count >= 5 {
        guard let value = Double(args[4]), value >= 0, value < seconds else {
            throw StretchError.usage
        }
        stillSeconds = value
    } else {
        stillSeconds = seconds / 2
    }
    let targetFPS: Int
    if args.count == 6 {
        guard let value = Int(args[5]), value == 30 || value == 60 else {
            throw StretchError.usage
        }
        targetFPS = value
    } else {
        targetFPS = 60
    }

    let input = URL(fileURLWithPath: args[1])
    let output = URL(fileURLWithPath: args[2])
    try? FileManager.default.removeItem(at: output)

    let asset = AVURLAsset(url: input)
    let tracks = try loadMetadataTracks(asset)
    guard tracks.count >= 2 else { throw StretchError.noMetadata }

    let composition = AVMutableComposition()
    let infoSource = tracks[0]
    let stillSource = tracks[1]
    guard let infoTrack = composition.addMutableTrack(
        withMediaType: .metadata,
        preferredTrackID: kCMPersistentTrackID_Invalid
    ), let stillTrack = composition.addMutableTrack(
        withMediaType: .metadata,
        preferredTrackID: kCMPersistentTrackID_Invalid
    ) else {
        throw StretchError.noMetadata
    }

    let infoStart = CMTime(seconds: 0.05, preferredTimescale: 60_000)
    let targetDuration = CMTime(seconds: seconds, preferredTimescale: 60_000)
    if targetFPS == 60 {
        let infoUnit = CMTime(seconds: 1, preferredTimescale: 60_000)
        let repetitions = Int(ceil(seconds))
        for index in 0..<repetitions {
            let destination = infoStart + CMTime(seconds: Double(index), preferredTimescale: 60_000)
            try infoTrack.insertTimeRange(
                CMTimeRange(start: infoStart, duration: infoUnit),
                of: infoSource,
                at: destination
            )
        }
        if infoTrack.timeRange.end > targetDuration + infoStart {
            infoTrack.removeTimeRange(CMTimeRange(
                start: targetDuration + infoStart,
                end: infoTrack.timeRange.end
            ))
        }
    } else {
        // The same camera-derived info sample is repeated, but its timing is
        // stretched to a genuine 30 Hz cadence. This keeps one metadata sample
        // per video frame instead of leaving a 60 Hz track beside a 30 fps clip.
        let sampleCount = Int((seconds * Double(targetFPS)).rounded())
        let sourceFrame = CMTime(value: 1, timescale: 60)
        for index in 0..<sampleCount {
            let sourceIndex = index % 60
            let sourceStart = infoStart + CMTime(value: Int64(sourceIndex), timescale: 60)
            let destination = infoStart + CMTime(value: Int64(index), timescale: 60)
            try infoTrack.insertTimeRange(
                CMTimeRange(start: sourceStart, duration: sourceFrame),
                of: infoSource,
                at: destination
            )
        }
        let packedDuration = CMTime(value: Int64(sampleCount), timescale: 60)
        infoTrack.scaleTimeRange(
            CMTimeRange(start: infoStart, duration: packedDuration),
            toDuration: targetDuration
        )
    }

    let stillSampleDuration = CMTime(value: 1, timescale: 600)
    let stillSourceStart = CMTime(seconds: 0.5, preferredTimescale: 600)
    let photoTime = CMTime(seconds: stillSeconds, preferredTimescale: 600)
    try stillTrack.insertTimeRange(
        CMTimeRange(start: stillSourceStart, duration: stillSampleDuration),
        of: stillSource,
        at: photoTime
    )

    try export(composition, to: output)
    print(output.path)
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
