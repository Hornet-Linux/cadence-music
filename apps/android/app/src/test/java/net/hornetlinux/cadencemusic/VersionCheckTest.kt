package net.hornetlinux.cadencemusic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class VersionCheckTest {
    @Test
    fun parsesPlainAndPrefixedVersions() {
        assertEquals(listOf(1, 2, 3), VersionCheck.parse("1.2.3"))
        assertEquals(listOf(1, 2, 3), VersionCheck.parse("v1.2.3"))
        assertEquals(listOf(0, 2), VersionCheck.parse(" V0.2 "))
        assertEquals(listOf(1, 2, 3), VersionCheck.parse("1.2.3-beta.1+build5"))
    }

    @Test
    fun nonVersionsDoNotParse() {
        assertNull(VersionCheck.parse("nightly"))
        assertNull(VersionCheck.parse(""))
        assertNull(VersionCheck.parse("v"))
        assertNull(VersionCheck.parse("1..2"))
        assertNull(VersionCheck.parse("1.x.3"))
    }

    @Test
    fun comparesNumericallyNotAlphabetically() {
        assertTrue(VersionCheck.isNewer("v0.10.0", "0.9.9"))
        assertTrue(VersionCheck.isNewer("1.0.0", "0.99.99"))
        assertTrue(VersionCheck.isNewer("0.2.1", "0.2.0"))
        assertFalse(VersionCheck.isNewer("0.2.0", "0.2.1"))
    }

    @Test
    fun equalVersionsAreNotNewerEvenWithDifferentLength() {
        assertFalse(VersionCheck.isNewer("v0.2.0", "0.2.0"))
        assertFalse(VersionCheck.isNewer("0.2", "0.2.0"))
        assertFalse(VersionCheck.isNewer("0.2.0", "0.2"))
        assertTrue(VersionCheck.isNewer("0.2.0.1", "0.2.0"))
    }

    @Test
    fun unparseableVersionsNeverPrompt() {
        assertFalse(VersionCheck.isNewer("nightly", "0.2.0"))
        assertFalse(VersionCheck.isNewer("v9.9.9", "dev"))
    }

    @Test
    fun checksAtMostOncePerDay() {
        val day = VersionCheck.CHECK_INTERVAL_MS
        assertTrue(VersionCheck.shouldCheck(1_000, 0))
        assertFalse(VersionCheck.shouldCheck(day - 1, 1))
        assertFalse(VersionCheck.shouldCheck(10 * 3_600_000L, 1_000))
        assertTrue(VersionCheck.shouldCheck(1_000 + day, 1_000))
        // a clock set back counts as "due" rather than blocking checks for years
        assertTrue(VersionCheck.shouldCheck(500, 10_000))
    }

    @Test
    fun readsTheLatestReleaseResponse() {
        val json = """{"tag_name":"v0.3.0","html_url":"https://github.com/Hornet-Linux/cadence-music/releases/tag/v0.3.0","draft":false,"prerelease":false}"""
        assertEquals(
            ReleaseInfo("v0.3.0", "https://github.com/Hornet-Linux/cadence-music/releases/tag/v0.3.0"),
            VersionCheck.parseRelease(json),
        )
    }

    @Test
    fun ignoresDraftsPreReleasesAndGarbage() {
        assertNull(VersionCheck.parseRelease("""{"tag_name":"v1.0.0","draft":true}"""))
        assertNull(VersionCheck.parseRelease("""{"tag_name":"v1.0.0","prerelease":true}"""))
        assertNull(VersionCheck.parseRelease("""{"html_url":"https://github.com/x"}"""))
        assertNull(VersionCheck.parseRelease("not json"))
    }

    @Test
    fun onlyLinksToGithubAndFallsBackToTheReleasesPage() {
        val evil = VersionCheck.parseRelease("""{"tag_name":"v1.0.0","html_url":"https://evil.example/apk"}""")
        assertEquals(VersionCheck.RELEASES_PAGE, evil?.pageUrl)
    }
}