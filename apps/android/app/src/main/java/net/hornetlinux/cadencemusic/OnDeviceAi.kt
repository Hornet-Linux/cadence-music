package net.hornetlinux.cadencemusic

import com.google.mlkit.genai.common.FeatureStatus
import com.google.mlkit.genai.prompt.Generation
import com.google.mlkit.genai.prompt.GenerativeModel
import com.google.mlkit.genai.prompt.SystemInstruction
import com.google.mlkit.genai.prompt.TextPart
import com.google.mlkit.genai.prompt.generateContentRequest
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Gemini Nano through Google's ML Kit GenAI Prompt API (AICore). The web player
 * reaches it through `window.CadenceNative` (see [WebScripts]), so the AI DJ can run
 * on the phone with no server and no API key.
 *
 * Only devices with AICore and a downloaded Gemini Nano report as available; everywhere
 * else (emulators, unsupported phones, unlocked bootloaders) [isAvailable] is false.
 */
object OnDeviceAi {
    const val NAME = "Gemini Nano"

    private val lock = Mutex()
    private var model: GenerativeModel? = null

    private fun client(): GenerativeModel = model ?: Generation.getClient().also { model = it }

    /** Whether the model is downloaded and ready right now. Never throws. */
    suspend fun isAvailable(): Boolean = try {
        client().checkStatus() == FeatureStatus.AVAILABLE
    } catch (e: CancellationException) {
        throw e
    } catch (_: Throwable) {
        false
    }

    /** Runs a chat and returns the model's reply text. */
    suspend fun chatJson(requestJson: String): String = lock.withLock {
        val prompt = AiPrompt.parse(requestJson)
        val model = client()
        check(model.checkStatus() == FeatureStatus.AVAILABLE) {
            "Gemini Nano isn't ready on this device"
        }
        val temp = prompt.temperature?.coerceIn(0f, 1f)
        val request = if (prompt.instructions.isNotBlank() && model.isSystemPromptAvailable()) {
            generateContentRequest(SystemInstruction(prompt.instructions), TextPart(prompt.prompt)) {
                this.temperature = temp
            }
        } else {
            val text = if (prompt.instructions.isBlank()) prompt.prompt else prompt.instructions + "\n\n" + prompt.prompt
            generateContentRequest(TextPart(text)) {
                this.temperature = temp
            }
        }
        val reply = model.generateContent(request).candidates.firstOrNull()?.text
        check(!reply.isNullOrBlank()) { "Gemini Nano returned no text" }
        reply
    }
}
