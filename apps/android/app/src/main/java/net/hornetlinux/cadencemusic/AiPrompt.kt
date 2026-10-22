package net.hornetlinux.cadencemusic

import org.json.JSONException
import org.json.JSONObject

/**
 * What the on-device model should be asked, parsed from the web player's request JSON:
 * `{ "messages": [{ "role", "content" }], "schema": {...}, "temperature": 0.8 }`.
 * Mirrors `AppleIntelligence.prepare` in the iOS app.
 */
data class AiPrompt(val instructions: String, val prompt: String, val temperature: Float?) {
    companion object {
        /** Throws [IllegalArgumentException] with a message fit to show the listener. */
        fun parse(requestJson: String): AiPrompt {
            val root = try {
                JSONObject(requestJson)
            } catch (_: JSONException) {
                throw IllegalArgumentException("The request wasn't valid JSON")
            }
            val messages = root.optJSONArray("messages")
                ?: throw IllegalArgumentException("The request wasn't valid JSON")

            val system = mutableListOf<String>()
            val conversation = mutableListOf<String>()
            for (i in 0 until messages.length()) {
                val message = messages.optJSONObject(i) ?: continue
                if (!message.has("role") || !message.has("content")) continue
                val content = message.optString("content")
                when (message.optString("role")) {
                    "system" -> system += content
                    "assistant" -> conversation += "Assistant: $content"
                    else -> conversation += content
                }
            }
            if (conversation.isEmpty()) throw IllegalArgumentException("The request had no messages")

            // The on-device model is small, so the schema goes in the instructions as plain
            // text and the page parses the reply.
            val schema = root.optJSONObject("schema")
            if (schema != null) {
                system += "Reply with a single JSON object that matches this JSON Schema, and nothing else:\n$schema"
            }
            val temperature = if (root.has("temperature") && !root.isNull("temperature")) {
                root.optDouble("temperature").takeIf { !it.isNaN() }?.toFloat()
            } else {
                null
            }
            return AiPrompt(system.joinToString("\n\n"), conversation.joinToString("\n\n"), temperature)
        }
    }
}
