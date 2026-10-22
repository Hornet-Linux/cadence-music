package net.hornetlinux.cadencemusic

import android.webkit.WebView
import androidx.activity.compose.BackHandler
import androidx.activity.compose.LocalActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties

/**
 * Hosts the server's web player (/app). The notification and lock screen come from the
 * page's Media Session (see [WebScripts] and [PlaybackService]).
 */
@Composable
fun PlayerScreen(playerUrl: String, onChangeServer: () -> Unit) {
    val activity = LocalActivity.current
    val scope = rememberCoroutineScope()
    var failure by remember { mutableStateOf<String?>(null) }
    var popup by remember { mutableStateOf<WebView?>(null) }

    val changeServer by rememberUpdatedState(onChangeServer)
    val player = remember(playerUrl) {
        PlayerWebView(
            context = activity!!,
            playerUrl = playerUrl,
            scope = scope,
            callbacks = object : PlayerCallbacks {
                override fun onFailure(message: String?) {
                    failure = message
                }

                override fun onPopup(child: WebView?) {
                    val old = popup
                    if (old != null && old !== child) old.destroy()
                    popup = child
                }

                override fun onChangeServer() = changeServer()
            },
        )
    }
    DisposableEffect(player) { onDispose { player.destroy() } }

    // Back goes through the page's history; at the start it sends the app to the background
    // rather than closing it, so music keeps playing.
    BackHandler {
        val current = popup
        when {
            current != null -> {
                popup = null
                current.destroy()
            }
            player.web.canGoBack() -> player.web.goBack()
            else -> activity?.moveTaskToBack(true)
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black).systemBarsPadding().imePadding()) {
        AndroidView(factory = { player.web }, modifier = Modifier.fillMaxSize())

        failure?.let { message ->
            Surface(
                modifier = Modifier.align(Alignment.Center).padding(16.dp),
                shape = RoundedCornerShape(16.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Text("Couldn't load your server", style = MaterialTheme.typography.titleMedium)
                    Text(
                        message,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                    Button(onClick = {
                        failure = null
                        player.reload()
                    }) { Text("Try again") }
                    TextButton(onClick = onChangeServer) { Text("Change server") }
                }
            }
        }
    }

    popup?.let { child ->
        Dialog(
            onDismissRequest = {
                popup = null
                child.destroy()
            },
            properties = DialogProperties(usePlatformDefaultWidth = false),
        ) {
            Surface(Modifier.fillMaxSize().systemBarsPadding(), color = Color.Black) {
                Column {
                    Row(Modifier.fillMaxWidth()) {
                        TextButton(onClick = {
                            popup = null
                            child.destroy()
                        }) { Text("Close") }
                    }
                    AndroidView(factory = { child }, modifier = Modifier.fillMaxSize())
                }
            }
        }
    }
}
