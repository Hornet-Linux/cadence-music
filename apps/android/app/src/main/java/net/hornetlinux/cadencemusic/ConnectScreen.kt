package net.hornetlinux.cadencemusic

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch

/**
 * Asks for the Cadence server's address, checks that it really is a Cadence server
 * (its /api/health answers), then hands back the address it answered from.
 */
@Composable
fun ConnectScreen(initialAddress: String, versionName: String, onConnected: (address: String) -> Unit) {
    var draft by remember { mutableStateOf(initialAddress) }
    var error by remember { mutableStateOf<String?>(null) }
    var checking by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val shortScreen = LocalConfiguration.current.screenHeightDp < 500

    fun connect() {
        if (checking) return
        val url = ServerAddress.playerUrl(draft)
        if (url == null) {
            error = "That doesn't look like a server address. Try something like music.example.com."
            return
        }
        checking = true
        error = null
        scope.launch {
            var result = ServerProbe.probe(url)
            if (result is ProbeResult.Failed) {
                // A bare LAN address usually has no certificate: try plain http before giving up.
                val lan = ServerAddress.lanHttpFallback(draft)
                if (lan != null) {
                    val retry = ServerProbe.probe(lan)
                    if (retry is ProbeResult.Ok) result = retry
                }
            }
            when (result) {
                is ProbeResult.Ok -> onConnected(result.address)
                is ProbeResult.Failed -> error = result.message
            }
            checking = false
        }
    }

    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(
            modifier = Modifier
                .widthIn(max = 480.dp)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 24.dp, vertical = 16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(14.dp),
        ) {
            if (shortScreen) {
                // Landscape phones: keep the field and button on screen without scrolling.
                Text(
                    "Cadence",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                )
            } else {
                Image(
                    painter = painterResource(R.drawable.cadence_logo),
                    contentDescription = null,
                    modifier = Modifier.size(72.dp),
                )
                Text(
                    "Cadence",
                    style = MaterialTheme.typography.headlineLarge,
                    color = MaterialTheme.colorScheme.onBackground,
                )
                Text(
                    "Connect to your Cadence server",
                    style = MaterialTheme.typography.titleMedium,
                    color = MaterialTheme.colorScheme.onBackground,
                    textAlign = TextAlign.Center,
                )
            }
            Text(
                "This is the web address you use to open Cadence in a browser. " +
                    "Examples: music.example.com, or http://192.168.1.20:8787 on your home network.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
            )
            OutlinedTextField(
                value = draft,
                onValueChange = {
                    draft = it
                    error = null
                },
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
                label = { Text("Server address") },
                placeholder = { Text("music.example.com") },
                singleLine = true,
                isError = error != null,
                supportingText = {
                    Text(
                        error ?: "No http:// or https:// needed for a normal secure server.",
                        color = if (error != null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                },
                keyboardOptions = KeyboardOptions(
                    capitalization = KeyboardCapitalization.None,
                    autoCorrectEnabled = false,
                    keyboardType = KeyboardType.Uri,
                    imeAction = ImeAction.Go,
                ),
                keyboardActions = KeyboardActions(onGo = { connect() }),
            )
            Button(
                onClick = ::connect,
                enabled = draft.isNotBlank() && !checking,
                modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp),
            ) {
                if (checking) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(22.dp),
                        strokeWidth = 2.dp,
                        color = MaterialTheme.colorScheme.onPrimary,
                    )
                } else {
                    Text("Connect", style = MaterialTheme.typography.titleMedium)
                }
            }
            Text(
                "Version $versionName",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}
