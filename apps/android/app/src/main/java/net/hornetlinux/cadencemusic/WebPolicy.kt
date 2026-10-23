package net.hornetlinux.cadencemusic

import java.net.URI

/**
 * What the player's WebView may load. Plain http is allowed (self-hosters run
 * Cadence on their LAN without certificates), but only to the configured
 * server and local-network addresses; everything else must be https. Links the
 * listener taps that leave the server open in the browser; redirects and
 * script navigations (sign-in with Spotify, Apple or the server's single
 * sign-on) stay in the app. Mirrors `WebPolicy` in the iOS app.
 */
object WebPolicy {
    enum class Decision { STAY, OPEN_EXTERNALLY, BLOCK }

    private val LOCAL_SUFFIXES = listOf(".local", ".lan", ".home.arpa", ".internal", ".localhost")

    /** Loopback, private and link-local addresses, and names that only exist on a home network. */
    fun isLocalHost(rawHost: String?): Boolean {
        val host = rawHost?.lowercase()?.trim('[', ']')?.trimEnd('.') ?: return false
        if (host.isEmpty()) return false
        if (host == "localhost" || LOCAL_SUFFIXES.any { host.endsWith(it) }) return true
        if (host.contains(':')) {
            // IPv6: loopback, unique local (fc00::/7), link-local (fe80::/10).
            return host == "::1" || host.startsWith("fc") || host.startsWith("fd") ||
                host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")
        }
        val parts = host.split('.')
        if (parts.size == 4 && parts.all { p -> p.isNotEmpty() && p.length <= 3 && p.all { it.isDigit() } }) {
            val (a, b) = parts.take(2).map { it.toInt() }
            return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) ||
                (a == 169 && b == 254) || (a == 100 && b in 64..127) // last: carrier-grade NAT, used by Tailscale
        }
        // A single-label name ("nas", "music") only resolves on the local network.
        return !host.contains('.')
    }

    private fun origin(uri: URI): String? {
        val scheme = uri.scheme?.lowercase() ?: return null
        val host = uri.host?.lowercase() ?: return null
        val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else if (scheme == "http") 80 else return null
        return "$scheme://$host:$port"
    }

    private fun parse(url: String): URI? = try { URI(url) } catch (_: Exception) { null }

    fun sameOrigin(url: String, server: String): Boolean {
        val a = parse(url)?.let(::origin) ?: return false
        val b = parse(server)?.let(::origin) ?: return false
        return a == b
    }

    /** May this http(s) URL be fetched? https always; http only to the server or a local address. */
    fun allowsLoad(url: String, server: String): Boolean {
        val uri = parse(url) ?: return false
        return when (uri.scheme?.lowercase()) {
            "https" -> true
            "http" -> sameOrigin(url, server) || isLocalHost(uri.host)
            else -> true // data:, blob:, about: never reach the network
        }
    }

    fun navigation(url: String, server: String, userTapped: Boolean, mainFrame: Boolean): Decision {
        val scheme = parse(url)?.scheme?.lowercase()
        if (scheme == "about" || scheme == "blob" || scheme == "data") return Decision.STAY
        if (scheme != "http" && scheme != "https") return Decision.OPEN_EXTERNALLY // mailto:, tel:, intent:
        if (sameOrigin(url, server)) return Decision.STAY
        if (userTapped && mainFrame) return Decision.OPEN_EXTERNALLY
        return if (allowsLoad(url, server)) Decision.STAY else Decision.BLOCK
    }
}
