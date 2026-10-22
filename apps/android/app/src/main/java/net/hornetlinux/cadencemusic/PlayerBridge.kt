package net.hornetlinux.cadencemusic

import android.content.Context
import android.util.Log
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * The native side of `window.CadenceNative` (see [WebScripts]).
 *
 * It's registered with `addWebMessageListener`, restricted to the server's own origin, so
 * pages the WebView visits during sign-in (an identity provider, Apple Music) can't call it.
 */
class PlayerBridge(
    private val context: Context,
    private val scope: CoroutineScope,
    private val onChangeServer: () -> Unit,
) {
    /** True if the script has to be injected by hand because the WebView can't run it at document start. */
    var needsManualInjection = true
        private set

    /** Returns false when this WebView is too old for the bridge; the player still works without it. */
    fun install(web: WebView, origin: String): Boolean {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            Log.w("Cadence", "This WebView has no WEB_MESSAGE_LISTENER; the native bridge is off")
            return false
        }
        WebViewCompat.addWebMessageListener(
            web,
            WebScripts.BRIDGE_NAME,
            setOf(origin),
        ) { _, message, _, _, replyProxy -> onMessage(message, replyProxy) }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(web, WebScripts.SOURCE, setOf(origin))
            needsManualInjection = false
        }
        return true
    }

    private fun onMessage(message: WebMessageCompat, reply: JavaScriptReplyProxy) {
        val json = try {
            JSONObject(message.data ?: return)
        } catch (_: Exception) {
            return
        }
        val id = json.optInt("id", -1)
        when (json.optString("op")) {
            "changeServer" -> onChangeServer()
            "media" -> onMedia(json)
            "aiAvailable" -> answer(reply, id) { OnDeviceAi.isAvailable() }
            "aiChat" -> answer(reply, id) { OnDeviceAi.chatJson(json.optString("request")) }
        }
    }

    private fun answer(reply: JavaScriptReplyProxy, id: Int, work: suspend () -> Any) {
        scope.launch {
            val response = JSONObject().put("id", id)
            try {
                response.put("result", work())
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Throwable) {
                response.put("error", e.message ?: e.javaClass.simpleName)
            }
            reply.postMessage(response.toString())
        }
    }

    private fun onMedia(json: JSONObject) {
        if (!json.optBoolean("active", false)) {
            PlaybackHub.clear()
            return
        }
        PlaybackHub.update(
            context,
            MediaState(
                title = json.optString("title"),
                artist = json.optString("artist"),
                album = json.optString("album"),
                artworkUrl = json.optString("artwork").ifBlank { null },
                playing = json.optBoolean("playing", false),
                positionMs = (json.optDouble("position", 0.0) * 1000).toLong().coerceAtLeast(0),
                durationMs = (json.optDouble("duration", 0.0) * 1000).toLong().coerceAtLeast(0),
            ),
        )
    }
}
