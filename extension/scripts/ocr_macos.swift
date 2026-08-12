import Foundation
import Vision
import ImageIO
import Darwin

struct OCRLine: Codable {
    let text: String
    let x: Double
    let y: Double
    let width: Double
    let height: Double
    let color: String?
}

struct OCRResponse: Codable {
    let ok: Bool
    let language: String?
    let angle: Double?
    let lineCount: Int?
    let lines: [OCRLine]?
    let error: String?
}

func emit(_ response: OCRResponse, exitCode: Int32 = 0) -> Never {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(response), let text = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((text + "\n").utf8))
    }
    exit(exitCode)
}

guard CommandLine.arguments.count >= 2 else {
    emit(OCRResponse(ok: false, language: nil, angle: nil, lineCount: nil, lines: nil, error: "用法：ocr_macos <图片路径>"), exitCode: 2)
}

let imagePath = CommandLine.arguments[1]
let imageURL = URL(fileURLWithPath: imagePath)
guard FileManager.default.fileExists(atPath: imagePath),
      let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    emit(OCRResponse(ok: false, language: nil, angle: nil, lineCount: nil, lines: nil, error: "找不到或无法读取导出的图片"), exitCode: 2)
}

let width = Double(image.width)
let height = Double(image.height)

func estimateTextColor(_ image: CGImage, x: Double, y: Double, width: Double, height: Double) -> String? {
    guard let providerData = image.dataProvider?.data, let base = CFDataGetBytePtr(providerData) else { return nil }
    let bytesPerPixel = image.bitsPerPixel / 8
    guard bytesPerPixel >= 3 else { return nil }
    let left = max(0, min(image.width - 1, Int(x)))
    let top = max(0, min(image.height - 1, Int(y)))
    let right = max(left + 1, min(image.width, Int(x + width)))
    let bottom = max(top + 1, min(image.height, Int(y + height)))
    let stepX = max(1, (right - left) / 48)
    let stepY = max(1, (bottom - top) / 24)
    var samples: [(r: Double, g: Double, b: Double, luminance: Double)] = []
    for py in stride(from: top, to: bottom, by: stepY) {
        for px in stride(from: left, to: right, by: stepX) {
            let offset = py * image.bytesPerRow + px * bytesPerPixel
            let r = Double(base[offset]); let g = Double(base[offset + 1]); let b = Double(base[offset + 2])
            samples.append((r, g, b, 0.299 * r + 0.587 * g + 0.114 * b))
        }
    }
    guard samples.count >= 8 else { return nil }
    let sorted = samples.map { $0.luminance }.sorted()
    let median = sorted[sorted.count / 2]
    let dark = samples.filter { $0.luminance < median - 10 }.sorted { $0.luminance < $1.luminance }
    let light = samples.filter { $0.luminance > median + 10 }.sorted { $0.luminance > $1.luminance }
    let darkSpread = dark.isEmpty ? 0 : median - dark[dark.count / 2].luminance
    let lightSpread = light.isEmpty ? 0 : light[light.count / 2].luminance - median
    let candidates = lightSpread >= darkSpread ? light : dark
    guard !candidates.isEmpty else { return nil }
    let selected = candidates.prefix(max(1, min(candidates.count, max(4, candidates.count / 5))))
    let sum = selected.reduce((r: 0.0, g: 0.0, b: 0.0)) { partial, sample in
        (partial.r + sample.r, partial.g + sample.g, partial.b + sample.b)
    }
    let count = Double(selected.count)
    return String(format: "#%02X%02X%02X", Int(max(0, min(255, sum.r / count))), Int(max(0, min(255, sum.g / count))), Int(max(0, min(255, sum.b / count))))
}
var regions: [[String: Double]] = []
if CommandLine.arguments.count > 2, let data = CommandLine.arguments[2].data(using: .utf8), let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Double]] {
    regions = parsed
}
if regions.isEmpty { regions = [["x": 0, "y": 0, "width": width, "height": height]] }

var lines: [OCRLine] = []
do {
    for region in regions {
        let rx = max(0, min(width, region["x"] ?? 0))
        let ry = max(0, min(height, region["y"] ?? 0))
        let rw = max(1, min(width - rx, region["width"] ?? width))
        let rh = max(1, min(height - ry, region["height"] ?? height))
        let cropRect = CGRect(x: Int(rx), y: Int(ry), width: max(1, Int(rw)), height: max(1, Int(rh)))
        guard let croppedImage = image.cropping(to: cropRect) else { continue }
        let request = VNRecognizeTextRequest { request, error in
            if let error = error { emit(OCRResponse(ok: false, language: nil, angle: nil, lineCount: nil, lines: nil, error: error.localizedDescription), exitCode: 2) }
            for observation in (request.results as? [VNRecognizedTextObservation]) ?? [] {
                guard let candidate = observation.topCandidates(1).first else { continue }
                let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else { continue }
                let box = observation.boundingBox
                let x = rx + box.origin.x * rw
                let y = ry + (1.0 - box.origin.y - box.height) * rh
                let pixelWidth = box.width * rw
                let pixelHeight = box.height * rh
                lines.append(OCRLine(text: text, x: x, y: y, width: pixelWidth, height: pixelHeight, color: estimateTextColor(image, x: x, y: y, width: pixelWidth, height: pixelHeight)))
            }
        }
        request.recognitionLevel = .accurate
        request.recognitionLanguages = ["zh-Hans", "en-US"]
        request.usesLanguageCorrection = true
        try VNImageRequestHandler(cgImage: croppedImage, options: [:]).perform([request])
    }
    lines.sort { lhs, rhs in
        if abs(lhs.y - rhs.y) > max(lhs.height, rhs.height) * 0.55 { return lhs.y < rhs.y }
        return lhs.x < rhs.x
    }
    emit(OCRResponse(ok: true, language: "zh-Hans,en-US", angle: 0, lineCount: lines.count, lines: lines, error: nil))
} catch {
    emit(OCRResponse(ok: false, language: nil, angle: nil, lineCount: nil, lines: nil, error: error.localizedDescription), exitCode: 2)
}
