package net.hornetlinux.cadencemusic

import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/** What the page's Media Session says is playing. */
data class MediaState(
    val title: String,
    val artist: String,
    val album: String,
    val artworkUrl: String?,
    val playing: Boolean,
    val positionMs: Long,
    val durationMs: Long,
)

/**
 * Connects the WebView (which plays the audio) to [PlaybackService] (which keeps the
 * process alive and shows the controls). Both live in the app's one process; everything
 * here is touched on the main thread.
 */
object PlaybackHub {
    @Volatile
    var state: MediaState? = null
        private set

    /** Runs a Media Session action ("play", "pause", "nexttrack", ...) in the page. */
    @Volatile
    var commandSink: ((action: String, seekSeconds: Double?) -> Unit)? = null

    fun update(context: Context, next: MediaState) {
        state = next
        val running = PlaybackService.instance
        if (running != null) {
            running.refresh()
        } else if (next.playing) {
            // Starting a foreground service while the app is in the background can be
            // refused (Android 12+); the page keeps playing either way.
            try {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, PlaybackService::class.java).setAction(PlaybackService.ACTION_SYNC),
                )
            } catch (e: Exception) {
                Log.w("Cadence", "Couldn't start the playback service", e)
            }
        }
    }

    fun clear() {
        state = null
        PlaybackService.instance?.shutdown()
    }

    fun send(action: String, seekSeconds: Double? = null) {
        commandSink?.invoke(action, seekSeconds)
    }
}
