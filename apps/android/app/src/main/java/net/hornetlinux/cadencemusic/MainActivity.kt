package net.hornetlinux.cadencemusic

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

class MainActivity : ComponentActivity() {
    private lateinit var store: ServerStore

    // Compose state held here (not in the composition) so a launcher shortcut arriving in onNewIntent can change it.
    private var address by mutableStateOf("")
    private var showNotificationExplainer by mutableStateOf(false)

    private val askForNotifications =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* playback works either way */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(
            statusBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
            navigationBarStyle = SystemBarStyle.auto(Color.TRANSPARENT, Color.TRANSPARENT),
        )
        super.onCreate(savedInstanceState)

        store = ServerStore(this)
        address = store.address
        handleIntent(intent)

        // Android 13+ hides the playback notification (and its lock-screen controls) unless the
        // person allows it. Explain and ask the first time music actually plays, not at launch.
        PlaybackHub.onPlaybackStarted = {
            if (needsNotificationPermission() && !store.notificationPromptShown) showNotificationExplainer = true
        }

        setContent {
            CadenceTheme {
                val dark = isSystemInDarkTheme()
                val playerUrl = ServerAddress.playerUrl(address)
                val view = LocalView.current
                SideEffect {
                    // The player sits on black, so its system bar icons must be light; the address screen follows the theme.
                    val light = playerUrl == null && !dark
                    WindowCompat.getInsetsController(window, view).apply {
                        isAppearanceLightStatusBars = light
                        isAppearanceLightNavigationBars = light
                    }
                }
                val background = if (playerUrl != null) androidx.compose.ui.graphics.Color.Black else MaterialTheme.colorScheme.background
                Surface(Modifier.fillMaxSize(), color = background) {
                    if (playerUrl != null) {
                        PlayerScreen(playerUrl = playerUrl, onChangeServer = ::changeServer)
                        UpdatePrompt(this@MainActivity, BuildConfig.VERSION_NAME)
                    } else {
                        Box(Modifier.fillMaxSize().safeDrawingPadding(), contentAlignment = Alignment.Center) {
                            ConnectScreen(
                                initialAddress = store.lastAddress,
                                versionName = BuildConfig.VERSION_NAME,
                                onConnected = {
                                    store.address = it
                                    address = it
                                },
                            )
                        }
                    }
                    if (showNotificationExplainer) {
                        NotificationExplainer(
                            onContinue = {
                                store.notificationPromptShown = true
                                showNotificationExplainer = false
                                askForNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
                            },
                            onNotNow = {
                                store.notificationPromptShown = true
                                showNotificationExplainer = false
                            },
                        )
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    /** The launcher's long-press "Change server" shortcut. */
    private fun handleIntent(intent: Intent?) {
        if (intent?.action == ACTION_CHANGE_SERVER) {
            intent.action = Intent.ACTION_MAIN
            changeServer()
        }
    }

    private fun changeServer() {
        store.address = ""
        address = ""
    }

    private fun needsNotificationPermission(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED

    override fun onDestroy() {
        PlaybackHub.onPlaybackStarted = null
        // The WebView plays the audio, so closing the activity ends playback; take the notification with it.
        if (isFinishing) PlaybackHub.clear()
        super.onDestroy()
    }

    companion object {
        const val ACTION_CHANGE_SERVER = "net.hornetlinux.cadencemusic.CHANGE_SERVER"
    }
}