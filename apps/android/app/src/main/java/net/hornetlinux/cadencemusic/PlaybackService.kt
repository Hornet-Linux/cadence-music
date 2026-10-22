package net.hornetlinux.cadencemusic

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.drawable.Icon
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.util.Log
import android.webkit.CookieManager
import java.net.HttpURLConnection
import java.net.URL

/**
 * Foreground service that keeps Cadence alive while music plays with the screen off, and
 * shows the media notification / lock-screen controls from the page's Media Session.
 * The audio itself is played by the WebView in [MainActivity]; this service only holds
 * the process, the CPU and Wi-Fi awake, and relays the controls back to the page.
 */
class PlaybackService : Service() {
    private lateinit var session: MediaSession
    private lateinit var notifications: NotificationManager
    private val main = Handler(Looper.getMainLooper())
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null

    private var artworkUrl: String? = null
    private var artwork: Bitmap? = null
    private var foreground = false

    override fun onCreate() {
        super.onCreate()
        instance = this
        notifications = getSystemService(NotificationManager::class.java)
        notifications.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.playback_channel), NotificationManager.IMPORTANCE_LOW),
        )
        session = MediaSession(this, "Cadence").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = PlaybackHub.send("play")
                override fun onPause() = PlaybackHub.send("pause")
                override fun onStop() = PlaybackHub.send("pause")
                override fun onSkipToNext() = PlaybackHub.send("nexttrack")
                override fun onSkipToPrevious() = PlaybackHub.send("previoustrack")
                override fun onSeekTo(pos: Long) = PlaybackHub.send("seekto", pos / 1000.0)
            })
            setSessionActivity(openAppIntent())
            isActive = true
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_SYNC -> refresh(startedAsForeground = true)
            ACTION_PLAY -> PlaybackHub.send("play")
            ACTION_PAUSE -> PlaybackHub.send("pause")
            ACTION_NEXT -> PlaybackHub.send("nexttrack")
            ACTION_PREVIOUS -> PlaybackHub.send("previoustrack")
            ACTION_DISMISS -> {
                PlaybackHub.send("pause")
                shutdown()
            }
        }
        return START_NOT_STICKY
    }

    /** Re-reads [PlaybackHub.state] into the session, the notification and the locks. */
    fun refresh(startedAsForeground: Boolean = false) {
        val state = PlaybackHub.state
        if (state == null) {
            // startForegroundService() promises a notification; give one before leaving.
            if (startedAsForeground) startForegroundCompat(buildNotification(null))
            shutdown()
            return
        }
        loadArtworkIfNeeded(state.artworkUrl)

        val metadata = MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, state.title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, state.artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, state.album)
        if (state.durationMs > 0) metadata.putLong(MediaMetadata.METADATA_KEY_DURATION, state.durationMs)
        artwork?.let { metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it) }
        session.setMetadata(metadata.build())
        session.setPlaybackState(
            PlaybackState.Builder()
                .setActions(
                    PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or
                        PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or
                        PlaybackState.ACTION_SEEK_TO,
                )
                .setState(
                    if (state.playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    state.positionMs,
                    if (state.playing) 1f else 0f,
                )
                .build(),
        )

        val notification = buildNotification(state)
        if (state.playing) {
            startForegroundCompat(notification)
            holdLocks()
        } else {
            releaseLocks()
            // A service started with startForegroundService() must call startForeground() once.
            if (startedAsForeground && !foreground) startForegroundCompat(notification)
            if (foreground) {
                // Keep the notification (so it can resume) but let the system reclaim us if it must.
                stopForeground(STOP_FOREGROUND_DETACH)
                foreground = false
            }
            notifications.notify(NOTIFICATION_ID, notification)
        }
    }

    fun shutdown() {
        releaseLocks()
        stopForeground(STOP_FOREGROUND_REMOVE)
        foreground = false
        notifications.cancel(NOTIFICATION_ID)
        stopSelf()
    }

    override fun onDestroy() {
        releaseLocks()
        session.isActive = false
        session.release()
        if (instance === this) instance = null
        super.onDestroy()
    }

    private fun startForegroundCompat(notification: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        foreground = true
    }

    private fun buildNotification(state: MediaState?): Notification {
        val builder = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_cadence)
            .setContentTitle(state?.title?.ifBlank { null } ?: getString(R.string.app_name))
            .setContentText(state?.artist)
            .setContentIntent(openAppIntent())
            .setDeleteIntent(serviceIntent(ACTION_DISMISS))
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
        if (state == null) return builder.build()
        builder.setOngoing(state.playing)
        artwork?.let { builder.setLargeIcon(it) }
        builder.addAction(action(android.R.drawable.ic_media_previous, "Previous", ACTION_PREVIOUS))
        if (state.playing) {
            builder.addAction(action(android.R.drawable.ic_media_pause, "Pause", ACTION_PAUSE))
        } else {
            builder.addAction(action(android.R.drawable.ic_media_play, "Play", ACTION_PLAY))
        }
        builder.addAction(action(android.R.drawable.ic_media_next, "Next", ACTION_NEXT))
        builder.setStyle(
            Notification.MediaStyle()
                .setMediaSession(session.sessionToken)
                .setShowActionsInCompactView(0, 1, 2),
        )
        return builder.build()
    }

    private fun action(icon: Int, title: String, action: String) =
        Notification.Action.Builder(Icon.createWithResource("android", icon), title, serviceIntent(action)).build()

    private fun serviceIntent(action: String): PendingIntent = PendingIntent.getService(
        this,
        action.hashCode(),
        Intent(this, PlaybackService::class.java).setAction(action),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun openAppIntent(): PendingIntent = PendingIntent.getActivity(
        this,
        0,
        Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun holdLocks() {
        if (wakeLock == null) {
            val power = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "cadence:playback")
        }
        if (wakeLock?.isHeld == false) wakeLock?.acquire(WAKE_LOCK_MAX_MS)
        if (wifiLock == null) {
            val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            @Suppress("DEPRECATION")
            wifiLock = wifi.createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "cadence:playback")
        }
        if (wifiLock?.isHeld == false) wifiLock?.acquire()
    }

    private fun releaseLocks() {
        if (wakeLock?.isHeld == true) wakeLock?.release()
        if (wifiLock?.isHeld == true) wifiLock?.release()
    }

    /** Fetches the cover art off the main thread (with the WebView's cookies) and refreshes when it lands. */
    private fun loadArtworkIfNeeded(url: String?) {
        if (url == artworkUrl) return
        artworkUrl = url
        artwork = null
        if (url.isNullOrBlank() || !(url.startsWith("http://") || url.startsWith("https://"))) return
        Thread {
            val bitmap = try {
                val connection = URL(url).openConnection() as HttpURLConnection
                connection.connectTimeout = 8_000
                connection.readTimeout = 8_000
                CookieManager.getInstance().getCookie(url)?.let { connection.setRequestProperty("Cookie", it) }
                try {
                    if (connection.responseCode == 200) BitmapFactory.decodeStream(connection.inputStream) else null
                } finally {
                    connection.disconnect()
                }
            } catch (e: Exception) {
                Log.w("Cadence", "Couldn't load cover art", e)
                null
            }
            main.post {
                if (artworkUrl == url && bitmap != null && instance === this) {
                    artwork = bitmap
                    refresh()
                }
            }
        }.start()
    }

    companion object {
        const val ACTION_SYNC = "net.hornetlinux.cadencemusic.SYNC"
        const val ACTION_PLAY = "net.hornetlinux.cadencemusic.PLAY"
        const val ACTION_PAUSE = "net.hornetlinux.cadencemusic.PAUSE"
        const val ACTION_NEXT = "net.hornetlinux.cadencemusic.NEXT"
        const val ACTION_PREVIOUS = "net.hornetlinux.cadencemusic.PREVIOUS"
        const val ACTION_DISMISS = "net.hornetlinux.cadencemusic.DISMISS"

        private const val CHANNEL = "playback"
        private const val NOTIFICATION_ID = 1
        private const val WAKE_LOCK_MAX_MS = 6L * 60 * 60 * 1000

        @Volatile
        var instance: PlaybackService? = null
            private set
    }
}
