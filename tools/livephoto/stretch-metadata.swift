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
            return "Usage: swift stretch-metadata.swift <input.mov> <output.mov> <seconds> [still-seconds]"
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
    guard (args.count == 4 || args.count == 5),
          let seconds = Double(args[3]), seconds > 0 else {
        throw StretchError.usage
    }
    let stillSeconds: Double
    if args.count == 5 {
        guard let value = Double(args[4]), value >= 0, value < seconds else {
            throw StretchError.usage
        }
        stillSeconds = value
    } else {
        stillSeconds = seconds / 2
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

    let infoUnit = CMTime(seconds: 1, preferredTimescale: 60_000)
    let infoStart = CMTime(seconds: 0.05, preferredTimescale: 60_000)
    let repetitions = Int(ceil(seconds))
    for index in 0..<repetitions {
        let destination = infoStart + CMTime(seconds: Double(index), preferredTimescale: 60_000)
        try infoTrack.insertTimeRange(
            CMTimeRange(start: infoStart, duration: infoUnit),
            of: infoSource,
            at: destination
        )
    }

    let targetDuration = CMTime(seconds: seconds, preferredTimescale: 60_000)
    if infoTrack.timeRange.end > targetDuration + infoStart {
        infoTrack.removeTimeRange(CMTimeRange(
            start: targetDuration + infoStart,
            end: infoTrack.timeRange.end
        ))
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
