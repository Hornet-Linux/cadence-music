package net.hornetlinux.cadencemusic

import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * Looks at most once a day for a newer release on GitHub. Sideloaded apps can't update
 * themselves, so this only tells the person; they open the release page and install it.
 * Offline or any error means "no prompt", silently.
 */
class UpdateChecker(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("cadence", Context.MODE_PRIVATE)

    /** A release newer than [currentVersion] that the person hasn't already been told about, or null. */
    suspend fun check(currentVersion: String, nowMs: Long = System.currentTimeMillis()): ReleaseInfo? {
        if (VersionCheck.parse(currentVersion) == null) return null // dev/nightly builds
        if (!VersionCheck.shouldCheck(nowMs, prefs.getLong(LAST_CHECK, 0))) return null
        val release = fetchLatest() ?: return null
        // Only a completed check counts, so being offline retries next launch instead of waiting a day.
        prefs.edit().putLong(LAST_CHECK, nowMs).apply()
        if (!VersionCheck.isNewer(release.tag, currentVersion)) return null
        if (prefs.getString(NOTIFIED_TAG, null) == release.tag) return null
        return release
    }

    /** Remember that the person saw the prompt for this release, so it isn't repeated. */
    fun markNotified(release: ReleaseInfo) {
        prefs.edit().putString(NOTIFIED_TAG, release.tag).apply()
    }

    private suspend fun fetchLatest(): ReleaseInfo? = withContext(Dispatchers.IO) {
        try {
            val connection = URL(VersionCheck.LATEST_RELEASE_API).openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 8_000
                connection.readTimeout = 8_000
                connection.setRequestProperty("Accept", "application/vnd.github+json")
                connection.setRequestProperty("User-Agent", "Cadence-Android")
                if (connection.responseCode != 200) return@withContext null
                VersionCheck.parseRelease(connection.inputStream.bufferedReader().use { it.readText() })
            } finally {
                connection.disconnect()
            }
        } catch (_: IOException) {
            null
        }
    }

    private companion object {
        const val LAST_CHECK = "updateLastCheck"
        const val NOTIFIED_TAG = "updateNotifiedTag"
    }
}
