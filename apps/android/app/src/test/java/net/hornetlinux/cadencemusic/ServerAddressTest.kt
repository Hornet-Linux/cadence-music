package net.hornetlinux.cadencemusic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ServerAddressTest {
    @Test
    fun bareHostDefaultsToHttps() {
        assertEquals("https://music.example.com/app/", ServerAddress.playerUrl("music.example.com"))
    }

    @Test
    fun keepsSchemeAndPortAndReplacesPath() {
        assertEquals("http://10.0.0.5:8787/app/", ServerAddress.playerUrl("http://10.0.0.5:8787/"))
        assertEquals("https://music.example.com/app/", ServerAddress.playerUrl("https://music.example.com/some/path?x=1#frag"))
    }

    @Test
    fun trimsWhitespaceAndLowercasesScheme() {
        assertEquals("https://music.example.com/app/", ServerAddress.playerUrl("  HTTPS://music.example.com  "))
    }

    @Test
    fun hostWithPortAndNoSchemeIsHttps() {
        assertEquals("https://music.example.com:8443/app/", ServerAddress.playerUrl("music.example.com:8443"))
    }

    @Test
    fun rejectsUnusableInput() {
        assertNull(ServerAddress.playerUrl(""))
        assertNull(ServerAddress.playerUrl("   "))
        assertNull(ServerAddress.playerUrl("ftp://music.example.com"))
        assertNull(ServerAddress.playerUrl("https://"))
        assertNull(ServerAddress.playerUrl("not a server"))
    }

    @Test
    fun originIsSchemeHostAndPort() {
        assertEquals("https://music.example.com", ServerAddress.origin("https://music.example.com/app/"))
        assertEquals("http://10.0.0.5:8787", ServerAddress.origin("http://10.0.0.5:8787/app/"))
    }
}
