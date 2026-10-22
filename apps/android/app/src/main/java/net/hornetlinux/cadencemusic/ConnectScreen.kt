package net.hornetlinux.cadencemusic

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/** First launch: ask for the Cadence server's address and check it serves /app. */
@Composable
fun ConnectScreen(onConnected: (address: String) -> Unit) {
    var draft by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    fun connect() {
        if (checking) return
        val url = ServerAddress.playerUrl(draft)
        if (url == null) {
            error = "That doesn't look like a server address."
            return
        }
        checking = true
        error = null
        scope.launch {
            val problem = checkServer(url)
            checking = false
            if (problem == null) onConnected(draft) else error = problem
        }
    }

    Column(
        modifier = Modifier
            .padding(24.dp)
            .widthIn(max = 480.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
    ) {
        Image(
            painter = painterResource(R.drawable.cadence_logo),
            contentDescription = null,
            modifier = Modifier.size(96.dp),
        )
        Text("Cadence", style = MaterialTheme.typography.displaySmall)
        Text(
            "Enter the address of your Cadence server.",
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        OutlinedTextField(
            value = draft,
            onValueChange = { draft = it },
            modifier = Modifier.fillMaxWidth(),
            placeholder = { Text("music.example.com") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(
                capitalization = KeyboardCapitalization.None,
                autoCorrectEnabled = false,
                keyboardType = KeyboardType.Uri,
                imeAction = ImeAction.Go,
            ),
            keyboardActions = KeyboardActions(onGo = { connect() }),
        )
        error?.let {
            Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center)
        }
        Button(onClick = ::connect, enabled = draft.isNotBlank() && !checking, modifier = Modifier.fillMaxWidth().height(52.dp)) {
            if (checking) CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp) else Text("Connect")
        }
        Spacer(Modifier.height(1.dp))
    }
}

/** Returns null if [playerUrl] answers 200, otherwise a message to show. Follows redirects, including http to https. */
private suspend fun checkServer(playerUrl: String): String? = withContext(Dispatchers.IO) {
    try {
        var url = URL(playerUrl)
        repeat(6) {
            val connection = url.openConnection() as HttpURLConnection
            try {
                connection.connectTimeout = 10_000
                connection.readTimeout = 10_000
                connection.instanceFollowRedirects = false
                val code = connection.responseCode
                val location = connection.getHeaderField("Location")
                if (code in listOf(301, 302, 303, 307, 308) && location != null) {
                    url = URL(url, location)
                    return@repeat
                }
                return@withContext if (code == 200) null else "Reached the server, but it has no web player at /app."
            } finally {
                connection.disconnect()
            }
        }
        "Couldn't reach the server: too many redirects"
    } catch (e: IOException) {
        "Couldn't reach the server: ${e.localizedMessage ?: e.javaClass.simpleName}"
    }
}
