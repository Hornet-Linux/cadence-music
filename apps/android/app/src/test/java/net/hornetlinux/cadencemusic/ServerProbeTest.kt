package net.hornetlinux.cadencemusic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class ServerProbeTest {
    private val health = """{"ok":true,"name":"cadence-server","version":"0.2.0","setupRequired":false}"""

    @Test
    fun acceptsACadenceHealthResponse() {
        val result = ServerProbe.interpret(200, health)
        assertTrue(result is ProbeResult.Ok)
        assertEquals("0.2.0", (result as ProbeResult.Ok).version)
    }

    @Test
    fun rejectsOtherServers() {
        assertEquals(ProbeResult.Failed(ServerProbe.NOT_CADENCE), ServerProbe.interpret(200, """{"ok":true,"name":"other"}"""))
        assertEquals(ProbeResult.Failed(ServerProbe.NOT_CADENCE), ServerProbe.interpret(200, "<html>hello</html>"))
        assertEquals(ProbeResult.Failed(ServerProbe.NOT_CADENCE), ServerProbe.interpret(404, "{}"))
        assertEquals(ProbeResult.Failed(ServerProbe.NOT_CADENCE), ServerProbe.interpret(200, """{"ok":false,"name":"cadence-server"}"""))
    }

    @Test
    fun serverErrorsAreReportedAsSuch() {
        val result = ServerProbe.interpret(502, "")
        assertTrue((result as ProbeResult.Failed).message.contains("502"))
    }

    @Test
    fun networkErrorsGetPlainLanguage() {
        assertTrue(ServerProbe.describe(UnknownHostException("x")).contains("find that server"))
        assertTrue(ServerProbe.describe(SocketTimeoutException()).contains("too long"))
        assertTrue(ServerProbe.describe(java.net.ConnectException("refused")).contains("Nothing answered"))
    }

    @Test
    fun friendlyWebErrors() {
        assertTrue(ErrorText.friendly("net::ERR_CONNECTION_REFUSED").contains("refused"))
        assertTrue(ErrorText.friendly("net::ERR_INTERNET_DISCONNECTED").contains("offline"))
        assertEquals("The page didn't load.", ErrorText.friendly(""))
        assertTrue(ErrorText.httpStatus(503).contains("503"))
    }
}