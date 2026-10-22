package net.hornetlinux.cadencemusic

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class AiPromptTest {
    @Test
    fun splitsSystemFromConversationAndPutsTheSchemaInTheInstructions() {
        val prompt = AiPrompt.parse(
            """{"messages":[{"role":"system","content":"You are a DJ."},{"role":"user","content":"Play something"},""" +
                """{"role":"assistant","content":"Sure"},{"role":"user","content":"Mellow"}],""" +
                """"schema":{"type":"object"},"temperature":0.8}""",
        )
        assertTrue(prompt.instructions.startsWith("You are a DJ."))
        assertTrue(prompt.instructions.contains("matches this JSON Schema"))
        assertTrue(prompt.instructions.contains("\"type\""))
        assertEquals("Play something\n\nAssistant: Sure\n\nMellow", prompt.prompt)
        assertEquals(0.8f, prompt.temperature!!, 0.0001f)
    }

    @Test
    fun schemaAndTemperatureAreOptional() {
        val prompt = AiPrompt.parse("""{"messages":[{"role":"user","content":"Hi"}]}""")
        assertEquals("", prompt.instructions)
        assertEquals("Hi", prompt.prompt)
        assertNull(prompt.temperature)
    }

    @Test
    fun rejectsBadRequests() {
        for (bad in listOf("not json", """{"messages":[]}""", """{"nothing":1}""")) {
            try {
                AiPrompt.parse(bad)
                fail("expected a failure for $bad")
            } catch (_: IllegalArgumentException) {
                // expected
            }
        }
    }
}
