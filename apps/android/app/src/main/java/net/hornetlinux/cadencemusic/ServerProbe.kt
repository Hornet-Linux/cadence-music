package net.hornetlinux.cadencemusic

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.ConnectException
import java.net.HttpURLConnection
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.URL
import java.net.UnknownHostException
import javax.net.ssl.SSLException

/** The outcome of asking a server's `/api/health` whether it is a Cadence server. */
sealed interface ProbeResult {
    /** [address] is the origin the server actually answered from (after redirects), e.g. https://music.example.com */
    data class Ok(val address: String, val version: String?) : ProbeResult
    data class Failed(val message: String) : ProbeResult
}

/** Checks a typed server address before it is saved. [interpret] is pure so it can be unit tested. */
object ServerProbe {
    const val EXPECTED_NAME = "cadence-server"
    const val NOT_CADENCE = "That address answered, but it isn't a Cadence server."

    /** Decide from a `/api/health` response. [code] is the HTTP status, [body] the response text. */
    fun interpret(code: Int, body: String): ProbeResult {
        if (code == 404 || code == 401 || code == 403) return ProbeResult.Failed(NOT_CADENCE)
        if (code !in 200..299) {
            return ProbeResult.Failed("The server answered with an error (HTTP $code). Try again in a moment.")
        }
        val json = try {
            JSONObject(body)
        } catch (_: JSONException) {
            return ProbeResult.Failed(NOT_CADENCE)
        }
        if (json.optString("name") != EXPECTED_NAME || !json.optBoolean("ok", false)) {
            return ProbeResult.Failed(NOT_CADENCE)
        }
        return ProbeResult.Ok(address = "", version = json.optString("version").ifBlank { null })
    }

    /** A person-readable reason for a network exception. */
    fun describe(e: IOException): String = when (e) {
        is UnknownHostException -> "Couldn't find that server. Check the spelling, and that this phone is online."
        is ConnectException, is NoRouteToHostException ->
            "Nothing answered at that address. Is the server running, and is the port right?"
        is SocketTimeoutException -> "The server took too long to answer. Check the address and your connection."
        is SSLException -> "The server's security certificate was rejected. If it has no certificate, type http:// before the address."
        else -> "Couldn't reach the server (${e.localizedMessage ?: e.javaClass.simpleName}). Check the address and your connection."
    }

    /** Probe `<server>/api/health`, following redirects (including http to https). */
    suspend fun probe(playerUrl: String): ProbeResult = withContext(Dispatchers.IO) {
        val origin = ServerAddress.origin(playerUrl)
            ?: return@withContext ProbeResult.Failed("That doesn't look like a server address.")
        try {
            var url = URL("$origin/api/health")
            repeat(6) {
                val connection = url.openConnection() as HttpURLConnection
                try {
                    connection.connectTimeout = 10_000
                    connection.readTimeout = 10_000
                    connection.instanceFollowRedirects = false
                    connection.setRequestProperty("Accept", "application/json")
                    val code = connection.responseCode
                    val location = connection.getHeaderField("Location")
                    if (code in listOf(301, 302, 303, 307, 308) && location != null) {
                        url = URL(url, location)
                        return@repeat
                    }
                    val stream = if (code in 200..299) connection.inputStream else connection.errorStream
                    val body = stream?.bufferedReader()?.use { it.readText().take(64 * 1024) }.orEmpty()
                    val result = interpret(code, body)
                    return@withContext if (result is ProbeResult.Ok) {
                        val port = if (url.port != -1 && url.port != url.defaultPort) ":${url.port}" else ""
                        result.copy(address = "${url.protocol}://${url.host}$port")
                    } else {
                        result
                    }
                } finally {
                    connection.disconnect()
                }
            }
            ProbeResult.Failed("The server redirected too many times.")
        } catch (e: IOException) {
            ProbeResult.Failed(describe(e))
        }
    }
}
