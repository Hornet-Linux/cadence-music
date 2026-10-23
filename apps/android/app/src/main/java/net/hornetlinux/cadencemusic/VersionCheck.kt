package net.hornetlinux.cadencemusic

import org.json.JSONException
import org.json.JSONObject

/** A GitHub release, as much of it as the update prompt needs. */
data class ReleaseInfo(val tag: String, val pageUrl: String)

/**
 * Pure helpers for the "a newer version is available" prompt, kept free of Android
 * types so they can be unit tested.
 */
object VersionCheck {
    const val LATEST_RELEASE_API = "https://api.github.com/repos/Hornet-Linux/cadence-music/releases/latest"
    const val RELEASES_PAGE = "https://github.com/Hornet-Linux/cadence-music/releases/latest"
    const val CHECK_INTERVAL_MS = 24L * 60 * 60 * 1000

    /**
     * Numeric parts of a version such as "v1.2.3" or "1.2.3-beta.1" (the pre-release suffix is
     * ignored). Returns null for tags that are not versions at all (such as "nightly").
     */
    fun parse(version: String): List<Int>? {
        val core = version.trim().removePrefix("v").removePrefix("V").substringBefore('-').substringBefore('+')
        if (core.isEmpty()) return null
        val numbers = core.split('.').map { it.toIntOrNull() ?: return null }
        return if (numbers.any { it < 0 }) null else numbers
    }

    /** True only if both parse and [latest] is strictly greater than [current]. */
    fun isNewer(latest: String, current: String): Boolean {
        val a = parse(latest) ?: return false
        val b = parse(current) ?: return false
        for (i in 0 until maxOf(a.size, b.size)) {
            val x = a.getOrElse(i) { 0 }
            val y = b.getOrElse(i) { 0 }
            if (x != y) return x > y
        }
        return false
    }

    /** At most one network check per [CHECK_INTERVAL_MS]; a clock that went backwards also triggers one. */
    fun shouldCheck(nowMs: Long, lastCheckMs: Long): Boolean =
        lastCheckMs <= 0 || nowMs < lastCheckMs || nowMs - lastCheckMs >= CHECK_INTERVAL_MS

    /** Reads GitHub's "latest release" response. Null for drafts, pre-releases and anything malformed. */
    fun parseRelease(json: String): ReleaseInfo? {
        val obj = try {
            JSONObject(json)
        } catch (_: JSONException) {
            return null
        }
        if (obj.optBoolean("draft", false) || obj.optBoolean("prerelease", false)) return null
        val tag = obj.optString("tag_name").takeIf { it.isNotBlank() } ?: return null
        val page = obj.optString("html_url").takeIf { it.startsWith("https://github.com/") } ?: RELEASES_PAGE
        return ReleaseInfo(tag, page)
    }
}
