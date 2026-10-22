package net.hornetlinux.cadencemusic

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/**
 * A calm, muted palette for the native screens (address screen, failure card, dialogs).
 * The brand gradient lives in the launcher icon and logo only; the UI chrome stays quiet.
 */
private val DarkScheme: ColorScheme = darkColorScheme(
    primary = Color(0xFF9FB4C7),
    onPrimary = Color(0xFF14202B),
    primaryContainer = Color(0xFF2A3947),
    onPrimaryContainer = Color(0xFFD7E3EF),
    secondary = Color(0xFFB3BDC7),
    onSecondary = Color(0xFF1C242C),
    background = Color(0xFF121416),
    onBackground = Color(0xFFE6E8EA),
    surface = Color(0xFF181B1E),
    onSurface = Color(0xFFE6E8EA),
    surfaceVariant = Color(0xFF23282D),
    onSurfaceVariant = Color(0xFFA9B0B7),
    outline = Color(0xFF626A72),
    outlineVariant = Color(0xFF353B41),
    error = Color(0xFFE5A09A),
    onError = Color(0xFF3A1511),
    errorContainer = Color(0xFF4A2724),
    onErrorContainer = Color(0xFFF6D2CF),
)

private val LightScheme: ColorScheme = lightColorScheme(
    primary = Color(0xFF3F5B73),
    onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFD9E5F0),
    onPrimaryContainer = Color(0xFF14202B),
    secondary = Color(0xFF55616C),
    onSecondary = Color(0xFFFFFFFF),
    background = Color(0xFFF6F7F8),
    onBackground = Color(0xFF191C1F),
    surface = Color(0xFFFFFFFF),
    onSurface = Color(0xFF191C1F),
    surfaceVariant = Color(0xFFE8EBEE),
    onSurfaceVariant = Color(0xFF50585F),
    outline = Color(0xFF7A838B),
    outlineVariant = Color(0xFFCDD2D7),
    error = Color(0xFFA23B35),
    onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFF7DAD7),
    onErrorContainer = Color(0xFF3A1511),
)

@Composable
fun CadenceTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, content = content)
}
