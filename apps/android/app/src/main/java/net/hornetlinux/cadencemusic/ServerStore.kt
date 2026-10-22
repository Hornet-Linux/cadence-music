package net.hornetlinux.cadencemusic

import android.content.Context

/** Remembers the address the person typed, like the iOS app's `serverURL` setting. */
class ServerStore(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("cadence", Context.MODE_PRIVATE)

    var address: String
        get() = prefs.getString(KEY, "") ?: ""
        set(value) = prefs.edit().putString(KEY, value).apply()

    private companion object {
        const val KEY = "serverURL"
    }
}
