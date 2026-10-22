import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Apple Intelligence's on-device language model (the Foundation Models
/// framework, iOS 26+ on supported hardware). The web player reaches it through
/// `window.CadenceNative` (see WebPlayer in PlayerView.swift), so the AI DJ can
/// run on the phone with no server and no API key.
///
/// The framework import is conditional, so the app still builds with older
/// Xcode SDKs; on those, and on older iOS or unsupported devices, it reports
/// itself as unavailable.
enum AppleIntelligence {
    enum Failure: LocalizedError {
        case unavailable(String)
        case badRequest(String)

        var errorDescription: String? {
            switch self {
            case .unavailable(let reason): return reason
            case .badRequest(let reason): return reason
            }
        }
    }

    /// What the model should be asked, parsed from the page's request JSON:
    /// `{ "messages": [{ "role", "content" }], "schema": {...}, "temperature": 0.8 }`.
    struct Prompt: Equatable {
        var instructions: String
        var prompt: String
        var temperature: Double?
    }

    /// The on-device model is small, so the schema goes in the instructions as
    /// plain text and the page parses the reply.
    static func prepare(requestJSON: String) throws -> Prompt {
        guard let data = requestJSON.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let messages = root["messages"] as? [[String: Any]]
        else { throw Failure.badRequest("The request wasn't valid JSON") }

        var system: [String] = []
        var conversation: [String] = []
        for message in messages {
            guard let role = message["role"] as? String, let content = message["content"] as? String else { continue }
            switch role {
            case "system": system.append(content)
            case "assistant": conversation.append("Assistant: \(content)")
            default: conversation.append(content)
            }
        }
        guard !conversation.isEmpty else { throw Failure.badRequest("The request had no messages") }

        if let schema = root["schema"], JSONSerialization.isValidJSONObject(schema),
           let schemaData = try? JSONSerialization.data(withJSONObject: schema, options: [.sortedKeys]),
           let schemaText = String(data: schemaData, encoding: .utf8) {
            system.append("Reply with a single JSON object that matches this JSON Schema, and nothing else:\n\(schemaText)")
        }
        return Prompt(
            instructions: system.joined(separator: "\n\n"),
            prompt: conversation.joined(separator: "\n\n"),
            temperature: root["temperature"] as? Double
        )
    }

    /// Whether the model can run right now, and why not when it can't.
    static func availability() -> (available: Bool, reason: String?) {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            switch SystemLanguageModel.default.availability {
            case .available:
                return (true, nil)
            case .unavailable(let reason):
                return (false, "Apple Intelligence isn't ready on this device (\(reason))")
            }
        }
        #endif
        return (false, "Needs iOS 26 or later on a device that supports Apple Intelligence")
    }

    /// Run a chat and return the model's reply text.
    static func chatJson(requestJSON: String) async throws -> String {
        let prompt = try prepare(requestJSON: requestJSON)
        let state = availability()
        guard state.available else { throw Failure.unavailable(state.reason ?? "Apple Intelligence is unavailable") }
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            let session = LanguageModelSession(instructions: prompt.instructions)
            let options = GenerationOptions(temperature: prompt.temperature)
            let response = try await session.respond(to: prompt.prompt, options: options)
            return response.content
        }
        #endif
        throw Failure.unavailable("Apple Intelligence is unavailable")
    }
}
