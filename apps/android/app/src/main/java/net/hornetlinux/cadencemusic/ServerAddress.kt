package net.hornetlinux.cadencemusic

import java.net.URI
import java.net.URISyntaxException

object ServerAddress {
    /**
     * Turns what the person typed ("music.example.com", "http://10.0.0.5:8787/")
     * into the server's web player URL, or null if it isn't a usable address.
     */
    fun playerUrl(input: String): String? {
        var text = input.trim()
        if (text.isEmpty()) return null
        if (!text.contains("://")) text = "https://$text"
        val uri = try {
            URI(text)
        } catch (_: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme?.lowercase() ?: return null
        if (scheme != "https" && scheme != "http") return null
        val host = uri.host?.takeIf { it.isNotEmpty() } ?: return null
        return try {
            URI(scheme, null, host, uri.port, "/app/", null, null).toString()
        } catch (_: URISyntaxException) {
            null
        }
    }

    /** `scheme://host[:port]` of a player URL, the form WebView origin rules take. */
    fun origin(playerUrl: String): String? {
        val uri = try {
            URI(playerUrl)
        } catch (_: URISyntaxException) {
            return null
        }
        val scheme = uri.scheme ?: return null
        val host = uri.host ?: return null
        return if (uri.port == -1) "$scheme://$host" else "$scheme://$host:${uri.port}"
    }
}
