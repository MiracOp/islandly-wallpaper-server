// Derived from apple-video-to-livephotos (MIT), Copyright (c) 2026 Teuku Fadhlul.
// Adapted for Islandly exact-profile Live Photo generation.
import Foundation
import AVFoundation
import CoreMedia
import ImageIO
import UniformTypeIdentifiers

/**
 * Live Photo Generator CLI - Template-based approach
 *
 * Creates Apple Live Photo compatible image+video pair by COPYING metadata from template.
 * This is the ONLY reliable way to create wallpaper-compatible Live Photos on iOS 17+.
 */

// MARK: - Error Types

enum LivePhotoError: Error, LocalizedError {
    case invalidArguments(String)
    case fileNotFound(String)
    case imageProcessingFailed(String)
    case videoProcessingFailed(String)
    case metadataWriteFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidArguments(let msg):
            return "Invalid arguments: \(msg)"
        case .fileNotFound(let path):
            return "File not found: \(path)"
        case .imageProcessingFailed(let msg):
            return "Image processing failed: \(msg)"
        case .videoProcessingFailed(let msg):
            return "Video processing failed: \(msg)"
        case .metadataWriteFailed(let msg):
            return "Metadata write failed: \(msg)"
        }
    }
}

// MARK: - Main Logic

func generateLivePhoto(
    stillImagePath: String,
    videoPath: String,
    templatePath: String,
    outputImagePath: String,
    outputVideoPath: String
) throws {
    // Generate asset identifier
    let assetIdentifier = UUID().uuidString

    print("Generated asset identifier: \(assetIdentifier)")

    // Verify input files exist
    let fileManager = FileManager.default
    guard fileManager.fileExists(atPath: stillImagePath) else {
        throw LivePhotoError.fileNotFound(stillImagePath)
    }
    guard fileManager.fileExists(atPath: videoPath) else {
        throw LivePhotoError.fileNotFound(videoPath)
    }
    guard fileManager.fileExists(atPath: templatePath) else {
        throw LivePhotoError.fileNotFound(templatePath)
    }

    // Process still image
    print("Processing still image...")
    try processStillImage(
        inputPath: stillImagePath,
        outputPath: outputImagePath,
        assetIdentifier: assetIdentifier
    )

    // Process video - COPY metadata from template
    print("Processing video with template metadata...")
    try copyMetadataFromTemplate(
        videoPath: videoPath,
        templatePath: templatePath,
        outputPath: outputVideoPath,
        assetIdentifier: assetIdentifier
    )

    print("✓ Live Photo created successfully")
    print("  Image: \(outputImagePath)")
    print("  Video: \(outputVideoPath)")
}

// MARK: - Image Processing

func processStillImage(
    inputPath: String,
    outputPath: String,
    assetIdentifier: String
) throws {
    guard let imageSource = CGImageSourceCreateWithURL(URL(fileURLWithPath: inputPath) as CFURL, nil),
          let imageRef = CGImageSourceCreateImageAtIndex(imageSource, 0, nil) else {
        throw LivePhotoError.imageProcessingFailed("Cannot read image")
    }

    // Get original metadata
    var metadata = CGImageSourceCopyPropertiesAtIndex(imageSource, 0, nil) as? [String: Any] ?? [:]

    // Add MakerApple metadata with asset identifier
    var makerApple: [String: Any] = metadata[kCGImagePropertyMakerAppleDictionary as String] as? [String: Any] ?? [:]
    makerApple["17"] = assetIdentifier
    metadata[kCGImagePropertyMakerAppleDictionary as String] = makerApple
    metadata[kCGImageDestinationLossyCompressionQuality as String] = 1.0

    // Detect output format based on file extension
    let outputFormat: String
    if outputPath.lowercased().hasSuffix(".heic") {
        outputFormat = UTType.heic.identifier
    } else {
        outputFormat = UTType.jpeg.identifier
    }

    guard let destination = CGImageDestinationCreateWithURL(
        URL(fileURLWithPath: outputPath) as CFURL,
        outputFormat as CFString,
        1,
        nil
    ) else {
        throw LivePhotoError.imageProcessingFailed("Cannot create destination")
    }

    CGImageDestinationAddImage(destination, imageRef, metadata as CFDictionary)

    guard CGImageDestinationFinalize(destination) else {
        throw LivePhotoError.metadataWriteFailed("Failed to write image metadata")
    }

    print("✓ Image metadata written")
}

// MARK: - Video Processing with Template Metadata Copying

func copyMetadataFromTemplate(
    videoPath: String,
    templatePath: String,
    outputPath: String,
    assetIdentifier: String
) throws {
    let videoAsset = AVURLAsset(url: URL(fileURLWithPath: videoPath))
    let templateAsset = AVURLAsset(url: URL(fileURLWithPath: templatePath))
    let outputURL = URL(fileURLWithPath: outputPath)

    // Create readers
    guard let videoReader = try? AVAssetReader(asset: videoAsset) else {
        throw LivePhotoError.videoProcessingFailed("Cannot create video reader")
    }

    guard let templateReader = try? AVAssetReader(asset: templateAsset) else {
        throw LivePhotoError.videoProcessingFailed("Cannot create template reader")
    }

    // Create writer
    guard let writer = try? AVAssetWriter(outputURL: outputURL, fileType: .mov) else {
        throw LivePhotoError.videoProcessingFailed("Cannot create writer")
    }

    // Setup video tracks
    let videoTracks = loadTracksSync(asset: videoAsset, mediaType: .video)
    guard let videoTrack = videoTracks.first else {
        throw LivePhotoError.videoProcessingFailed("No video track")
    }

    // Keep the already encoded HEVC samples compressed. Decoding to BGRA here and
    // encoding again visibly reduced quality and increased generation time.
    let videoReaderOutput = AVAssetReaderTrackOutput(
        track: videoTrack,
        outputSettings: nil
    )
    videoReader.add(videoReaderOutput)

    guard let sourceFormat = videoTrack.formatDescriptions.first else {
        throw LivePhotoError.videoProcessingFailed("Cannot read source video format")
    }
    let sourceFormatHint = sourceFormat as! CMFormatDescription

    // Passthrough input copies compressed video samples byte-for-byte while the
    // camera-derived metadata tracks are added alongside them.
    let videoWriterInput = AVAssetWriterInput(
        mediaType: .video,
        outputSettings: nil,
        sourceFormatHint: sourceFormatHint
    )
    videoWriterInput.transform = videoTrack.preferredTransform // CRITICAL: Preserve orientation
    videoWriterInput.expectsMediaDataInRealTime = false
    writer.add(videoWriterInput)

    // Setup metadata tracks from template
    var metadataInputs: [(AVAssetWriterInput, AVAssetReaderTrackOutput)] = []
    let metadataTracks = loadTracksSync(asset: templateAsset, mediaType: .metadata)

    for metadataTrack in metadataTracks {
        let metadataReaderOutput = AVAssetReaderTrackOutput(track: metadataTrack, outputSettings: nil)
        templateReader.add(metadataReaderOutput)

        let metadataWriterInput = AVAssetWriterInput(mediaType: .metadata, outputSettings: nil)
        writer.add(metadataWriterInput)

        metadataInputs.append((metadataWriterInput, metadataReaderOutput))
    }

    // Set content identifier metadata
    let contentIdItem = AVMutableMetadataItem()
    contentIdItem.keySpace = .quickTimeMetadata
    contentIdItem.key = "com.apple.quicktime.content.identifier" as NSString
    contentIdItem.value = assetIdentifier as NSString
    writer.metadata = [contentIdItem]

    // Start reading/writing
    guard videoReader.startReading() else {
        throw LivePhotoError.videoProcessingFailed("Cannot start video reading")
    }

    guard templateReader.startReading() else {
        throw LivePhotoError.videoProcessingFailed("Cannot start template reading")
    }

    guard writer.startWriting() else {
        throw LivePhotoError.videoProcessingFailed("Cannot start writing: \(writer.error?.localizedDescription ?? "unknown")")
    }

    writer.startSession(atSourceTime: .zero)

    // Use dispatch group to wait for all tracks
    let dispatchGroup = DispatchGroup()

    // Copy video samples
    dispatchGroup.enter()
    videoWriterInput.requestMediaDataWhenReady(on: DispatchQueue(label: "videoQueue")) {
        while videoWriterInput.isReadyForMoreMediaData {
            if let sampleBuffer = videoReaderOutput.copyNextSampleBuffer() {
                if !videoWriterInput.append(sampleBuffer) {
                    print("Failed to append video sample")
                    break
                }
            } else {
                videoWriterInput.markAsFinished()
                dispatchGroup.leave()
                break
            }
        }
    }

    // Copy metadata samples from template
    for (metadataInput, metadataOutput) in metadataInputs {
        dispatchGroup.enter()
        metadataInput.requestMediaDataWhenReady(on: DispatchQueue(label: "metadataQueue")) {
            while metadataInput.isReadyForMoreMediaData {
                if let sampleBuffer = metadataOutput.copyNextSampleBuffer() {
                    if !metadataInput.append(sampleBuffer) {
                        print("Failed to append metadata sample")
                        break
                    }
                } else {
                    metadataInput.markAsFinished()
                    dispatchGroup.leave()
                    break
                }
            }
        }
    }

    // Wait for all tracks to finish
    dispatchGroup.wait()

    // Finish writing
    let semaphore = DispatchSemaphore(value: 0)
    var writeError: Error?

    writer.finishWriting {
        if writer.status == .failed {
            writeError = writer.error
        }
        semaphore.signal()
    }

    semaphore.wait()

    if let error = writeError {
        throw LivePhotoError.videoProcessingFailed("Write failed: \(error.localizedDescription)")
    }

    if videoReader.status == .failed {
        throw LivePhotoError.videoProcessingFailed("Video reader failed: \(videoReader.error?.localizedDescription ?? "unknown")")
    }

    if templateReader.status == .failed {
        throw LivePhotoError.videoProcessingFailed("Template reader failed: \(templateReader.error?.localizedDescription ?? "unknown")")
    }

    print("✓ Video metadata copied from template")
}

// MARK: - Helper Functions

func loadTracksSync(asset: AVAsset, mediaType: AVMediaType) -> [AVAssetTrack] {
    let semaphore = DispatchSemaphore(value: 0)
    var tracks: [AVAssetTrack] = []

    if #available(macOS 12.0, *) {
        asset.loadTracks(withMediaType: mediaType) { loadedTracks, error in
            if let error = error {
                print("Error loading tracks: \(error)")
            }
            tracks = loadedTracks ?? []
            semaphore.signal()
        }
        semaphore.wait()
    } else {
        // Fallback for older macOS
        tracks = asset.tracks(withMediaType: mediaType)
    }

    return tracks
}

// MARK: - Entry Point

func main() {
    let args = CommandLine.arguments

    guard args.count == 6 else {
        print("Usage: LivePhotoGenerator <still-image> <video> <template-metadata> <output-image> <output-video>")
        print("")
        print("Arguments:")
        print("  still-image        Path to input image (HEIC or JPEG)")
        print("  video              Path to input MOV video (already processed)")
        print("  template-metadata  Path to template metadata.mov from real iOS device")
        print("  output-image       Path for output HEIC with metadata")
        print("  output-video       Path for output MOV with metadata")
        print("")
        print("IMPORTANT: Video must be pre-processed to match template specs:")
        print("  - Resized to target dimensions while preserving aspect ratio")
        print("  - Duration adjusted to match template")
        exit(1)
    }

    let stillImagePath = args[1]
    let videoPath = args[2]
    let templatePath = args[3]
    let outputImagePath = args[4]
    let outputVideoPath = args[5]

    do {
        try generateLivePhoto(
            stillImagePath: stillImagePath,
            videoPath: videoPath,
            templatePath: templatePath,
            outputImagePath: outputImagePath,
            outputVideoPath: outputVideoPath
        )
        exit(0)
    } catch {
        print("Error: \(error.localizedDescription)")
        exit(1)
    }
}

main()
