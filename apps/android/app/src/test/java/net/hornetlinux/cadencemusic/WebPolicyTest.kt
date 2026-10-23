package net.hornetlinux.cadencemusic

import net.hornetlinux.cadencemusic.WebPolicy.Decision
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class WebPolicyTest {
    private val lan = "http://192.168.1.20:8787/app/"
    private val public = "https://music.example.com/app/"

    @Test
    fun localAddresses() {
        listOf("localhost", "127.0.0.1", "10.0.0.5", "172.16.3.4", "172.31.255.1", "192.168.1.20", "169.254.1.1",
            "100.101.102.103", "nas", "nas.local", "music.lan", "box.home.arpa", "::1", "[fd12::1]", "fe80::1")
            .forEach { assertTrue(it, WebPolicy.isLocalHost(it)) }
        listOf("8.8.8.8", "172.32.0.1", "192.169.1.1", "100.128.0.1", "example.com", "music.example.com", "2001:db8::1", "", null)
            .forEach { assertFalse(it.toString(), WebPolicy.isLocalHost(it)) }
    }

    @Test
    fun cleartextOnlyToTheServerOrTheLan() {
        assertTrue(WebPolicy.allowsLoad("http://192.168.1.20:8787/api/health", lan))
        assertTrue(WebPolicy.allowsLoad("http://nas.local/cover.jpg", public))
        assertTrue(WebPolicy.allowsLoad("https://i.scdn.co/image/x", lan))
        assertFalse(WebPolicy.allowsLoad("http://tracker.example.net/pixel.gif", lan))
        // A plain-http server with a public name still works for itself.
        assertTrue(WebPolicy.allowsLoad("http://music.example.org/app/x.js", "http://music.example.org/app/"))
    }

    @Test
    fun tappedLinksOffTheServerOpenInTheBrowser() {
        assertEquals(Decision.STAY, WebPolicy.navigation("http://192.168.1.20:8787/app/#/library", lan, userTapped = true, mainFrame = true))
        assertEquals(Decision.OPEN_EXTERNALLY, WebPolicy.navigation("https://github.com/Hornet-Linux", lan, userTapped = true, mainFrame = true))
        assertEquals(Decision.OPEN_EXTERNALLY, WebPolicy.navigation("mailto:a@b.c", lan, userTapped = true, mainFrame = true))
    }

    @Test
    fun signInRedirectsStayButNotOverPlainHttp() {
        // The server's single sign-on redirect and Spotify's sign-in are script/redirect navigations.
        assertEquals(Decision.STAY, WebPolicy.navigation("https://auth.example.com/authorize?x=1", public, userTapped = false, mainFrame = true))
        assertEquals(Decision.STAY, WebPolicy.navigation("https://accounts.spotify.com/authorize", public, userTapped = false, mainFrame = true))
        assertEquals(Decision.BLOCK, WebPolicy.navigation("http://evil.example/phish", public, userTapped = false, mainFrame = true))
    }
}
