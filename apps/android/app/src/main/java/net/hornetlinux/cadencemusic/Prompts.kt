package net.hornetlinux.cadencemusic

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.delay

/** Shown the first time music plays, before Android's own permission dialog, so the request makes sense. */
@Composable
fun NotificationExplainer(onContinue: () -> Unit, onNotNow: () -> Unit) {
    AlertDialog(
        onDismissRequest = onNotNow,
        title = { Text("Show playback controls?") },
        text = {
            Text(
                "Cadence can show what's playing, with play, pause and skip buttons, in the notification " +
                    "shade and on your lock screen. Android needs your permission for that. " +
                    "Music plays either way.",
            )
        },
        confirmButton = { TextButton(onClick = onContinue) { Text("Continue") } },
        dismissButton = { TextButton(onClick = onNotNow) { Text("Not now") } },
    )
}

/** A gentle, once-per-release note that a newer APK exists. Sideloaded apps cannot update themselves. */
@Composable
fun UpdatePrompt(context: Context, currentVersion: String) {
    var release by remember { mutableStateOf<ReleaseInfo?>(null) }
    val checker = remember { UpdateChecker(context) }
    LaunchedEffect(Unit) {
        delay(4_000) // let the player settle first
        val found = checker.check(currentVersion)
        if (found != null) {
            checker.markNotified(found)
            release = found
        }
    }
    release?.let { found ->
        AlertDialog(
            onDismissRequest = { release = null },
            title = { Text("A newer version is available") },
            text = {
                Text(
                    "Cadence ${found.tag.removePrefix("v")} is out; you have $currentVersion. " +
                        "Updates are not installed automatically: open the release page, " +
                        "download Cadence.apk and install it over this one.",
                )
            },
            confirmButton = {
                TextButton(onClick = {
                    release = null
                    try {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(found.pageUrl)))
                    } catch (_: ActivityNotFoundException) {
                        // No browser installed; nothing more to do.
                    }
                }) { Text("View release") }
            },
            dismissButton = { TextButton(onClick = { release = null }) { Text("Later") } },
        )
    }
}