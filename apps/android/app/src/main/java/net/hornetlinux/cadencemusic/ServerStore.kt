package net.hornetlinux.cadencemusic

import android.content.Context

/** Remembers the server address, like the iOS app's `serverURL` setting. */
class ServerStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("cadence", Context.MODE_PRIVATE)

    /** The server in use. Empty means "ask for one" (first launch, or after Change server). */
    var address: String
        get() = prefs.getString(KEY, "") ?: ""
        set(value) {
            val edit = prefs.edit().putString(KEY, value)
            // Keep the last real address so the address screen can offer it again after Change server.
            if (value.isNotBlank()) edit.putString(LAST_KEY, value)
            edit.apply()
        }

    /** The most recent address that was connected, even after Change server cleared [address]. */
    val lastAddress: String
        get() = prefs.getString(LAST_KEY, "") ?: ""

    /** Whether the in-context "show playback controls?" explanation has been shown already. */
    var notificationPromptShown: Boolean
        get() = prefs.getBoolean(NOTIFY_KEY, false)
        set(value) = prefs.edit().putBoolean(NOTIFY_KEY, value).apply()

    private companion object {
        const val KEY = "serverURL"
        const val LAST_KEY = "lastServerURL"
        const val NOTIFY_KEY = "notificationPromptShown"
    }
}
