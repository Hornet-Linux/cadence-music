package net.hornetlinux.cadencemusic

/** Turns WebView's `net::ERR_*` descriptions into something a person can act on. */
object ErrorText {
    fun friendly(description: String?): String {
        val d = description.orEmpty()
        return when {
            d.contains("ERR_INTERNET_DISCONNECTED") || d.contains("ERR_NETWORK_CHANGED") ->
                "This phone looks offline. Cadence will try again when the connection is back."
            d.contains("ERR_NAME_NOT_RESOLVED") ->
                "The server's name couldn't be found. Check the address, or that this phone is online."
            d.contains("ERR_CONNECTION_REFUSED") ->
                "The server refused the connection. Is it running, and is the port right?"
            d.contains("ERR_CONNECTION_TIMED_OUT") || d.contains("ERR_TIMED_OUT") ->
                "The server took too long to answer."
            d.contains("ERR_CONNECTION_RESET") || d.contains("ERR_CONNECTION_CLOSED") || d.contains("ERR_EMPTY_RESPONSE") ->
                "The connection to the server was cut off."
            d.contains("ERR_SSL") || d.contains("ERR_CERT") ->
                "The server's security certificate was rejected."
            d.isBlank() -> "The page didn't load."
            else -> d.removePrefix("net::")
        }
    }

    fun httpStatus(code: Int): String = when (code) {
        502, 503, 504 -> "The server is not answering right now (HTTP $code). It may be restarting."
        else -> "The server reported an error (HTTP $code)."
    }
}
