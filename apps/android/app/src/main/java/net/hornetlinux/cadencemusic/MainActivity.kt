package net.hornetlinux.cadencemusic

import android.Manifest
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.core.content.ContextCompat

class MainActivity : ComponentActivity() {
    private val askForNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* playback works either way */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.dark(Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        // Android 13+ hides the playback notification (and its lock-screen controls) without this.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            askForNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        val store = ServerStore(this)
        setContent {
            MaterialTheme(colorScheme = darkColorScheme()) {
                var address by remember { mutableStateOf(store.address) }
                val playerUrl = ServerAddress.playerUrl(address)
                if (playerUrl != null) {
                    PlayerScreen(playerUrl = playerUrl, onChangeServer = {
                        store.address = ""
                        address = ""
                    })
                } else {
                    Box(
                        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).systemBarsPadding().imePadding(),
                        contentAlignment = Alignment.Center,
                    ) {
                        ConnectScreen(onConnected = {
                            store.address = it
                            address = it
                        })
                    }
                }
            }
        }
    }

    override fun onDestroy() {
        // The WebView plays the audio, so closing the activity ends playback; take the notification with it.
        if (isFinishing) PlaybackHub.clear()
        super.onDestroy()
    }
}
