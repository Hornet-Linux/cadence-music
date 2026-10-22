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

    /**
     * For a bare address typed without a scheme that points at a local-network machine
     * (an IP address, localhost, or a .local/.lan/.home name), the plain-http address to try
     * if https fails: such servers usually have no certificate. Null for anything else.
     */
    fun lanHttpFallback(input: String): String? {
        val text = input.trim()
        if (text.isEmpty() || text.contains("://")) return null
        val https = playerUrl(text) ?: return null
        val uri = try {
            URI(https)
        } catch (_: URISyntaxException) {
            return null
        }
        val host = uri.host?.lowercase() ?: return null
        val isIp = Regex("""\d{1,3}(\.\d{1,3}){3}""").matches(host)
        val isLocalName = host == "localhost" || host.endsWith(".local") || host.endsWith(".lan") || host.endsWith(".home")
        if (!isIp && !isLocalName) return null
        return https.replaceFirst("https://", "http://")
    }}
