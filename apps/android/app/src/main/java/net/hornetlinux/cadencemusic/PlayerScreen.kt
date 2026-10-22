package net.hornetlinux.cadencemusic

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
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
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
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
    // Bumped when the WebView's renderer dies, so a brand new WebView is built.
    var generation by remember { mutableIntStateOf(0) }

    val changeServer by rememberUpdatedState(onChangeServer)
    val player = remember(playerUrl, generation) {
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

                override fun onRenderGone(crashed: Boolean) {
                    popup?.destroy()
                    popup = null
                    failure = null
                    generation++
                }
            },
        )
    }
    DisposableEffect(player) { onDispose { player.destroy() } }

    // While the "couldn't load" card is up, retry on its own as soon as a network comes back.
    DisposableEffect(failure != null, player) {
        val manager = activity?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
        val callback = object : ConnectivityManager.NetworkCallback() {
            // Registering reports the network that is already up; only a later (re)connection should retry.
            private var first = true

            override fun onAvailable(network: Network) {
                if (first) {
                    first = false
                    return
                }
                player.web.post {
                    failure = null
                    player.reload()
                }
            }
        }
        if (failure != null && manager != null) {
            try {
                manager.registerDefaultNetworkCallback(callback)
            } catch (_: SecurityException) {
                // No network-state access; the Try again button still works.
            }
        }
        onDispose {
            if (failure != null && manager != null) {
                try {
                    manager.unregisterNetworkCallback(callback)
                } catch (_: IllegalArgumentException) {
                    // Was never registered.
                }
            }
        }
    }

    // Back goes through the page's history; at the start it sends the app to the background
    // rather than closing it, so music keeps playing.
    BackHandler {
        val current = popup
        when {
            current != null -> {
                popup = null
                current.destroy()
            }
            failure == null && player.web.canGoBack() -> player.web.goBack()
            else -> activity?.moveTaskToBack(true)
        }
    }

    Box(Modifier.fillMaxSize().background(Color.Black).safeDrawingPadding()) {
        // The factory only runs once per composition, so key it on the player: after a renderer crash
        // a new WebView has to be attached.
        key(player) {
            AndroidView(factory = { player.web }, modifier = Modifier.fillMaxSize())
        }

        failure?.let { message ->
            Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background)) {
                Surface(
                    modifier = Modifier.align(Alignment.Center).padding(16.dp),
                    shape = RoundedCornerShape(16.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    contentColor = MaterialTheme.colorScheme.onSurface,
                ) {
                    Column(
                        modifier = Modifier.padding(24.dp).verticalScroll(rememberScrollState()),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(12.dp),
                    ) {
                        Text("Can't reach your server", style = MaterialTheme.typography.titleMedium)
                        Text(
                            message,
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center,
                        )
                        Button(
                            onClick = {
                                failure = null
                                player.reload()
                            },
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) { Text("Try again") }
                        TextButton(
                            onClick = onChangeServer,
                            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp),
                        ) { Text("Change server") }
                    }
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
            Surface(Modifier.fillMaxSize().safeDrawingPadding(), color = Color.Black) {
                Column {
                    Row(Modifier.fillMaxWidth()) {
                        TextButton(
                            onClick = {
                                popup = null
                                child.destroy()
                            },
                            modifier = Modifier.heightIn(min = 48.dp),
                            colors = ButtonDefaults.textButtonColors(contentColor = Color.White),
                        ) { Text("Close") }
                    }
                    AndroidView(factory = { child }, modifier = Modifier.fillMaxSize())
                }
            }
        }
    }
}