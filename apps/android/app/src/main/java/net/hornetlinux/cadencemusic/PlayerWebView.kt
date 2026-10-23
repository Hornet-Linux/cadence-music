package net.hornetlinux.cadencemusic

import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Message
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CoroutineScope
import org.json.JSONObject
import java.io.ByteArrayInputStream

/** What the player WebView needs the surrounding screen to do. */
interface PlayerCallbacks {
    fun onFailure(message: String?)
    fun onPopup(popup: WebView?)
    fun onChangeServer()

    /** The WebView's renderer process died (out of memory or a crash); the screen should build a fresh player. */
    fun onRenderGone(crashed: Boolean)
}

/**
 * The server's web player (/app) in a WebView, so the Android app shares its UI and
 * sign-in redirects. Mirrors `WebPlayer` in the iOS app.
 */
class PlayerWebView(
    private val context: Context,
    private val playerUrl: String,
    scope: CoroutineScope,
    private val callbacks: PlayerCallbacks,
) {
    private val bridge = PlayerBridge(context.applicationContext, scope) { callbacks.onChangeServer() }
    private var loadFailed = false

    val web: WebView = WebView(context)

    init {
        configure(web)
        web.webViewClient = MainClient()
        web.webChromeClient = MainChrome()

        val origin = ServerAddress.origin(playerUrl)
        if (origin != null) bridge.install(web, origin)

        // Controls pressed in the notification / lock screen run the page's Media Session handlers.
        PlaybackHub.commandSink = { action, seekSeconds ->
            web.post {
                val detail = if (seekSeconds != null) JSONObject().put("seekTime", seekSeconds).toString() else "null"
                web.evaluateJavascript(
                    "window.__cadenceMediaAction && window.__cadenceMediaAction('$action', $detail)",
                    null,
                )
            }
        }
        web.loadUrl(playerUrl)
    }

    fun reload() {
        loadFailed = false
        web.loadUrl(playerUrl)
    }

    fun destroy() {
        PlaybackHub.commandSink = null
        PlaybackHub.clear()
        (web.parent as? ViewGroup)?.removeView(web)
        web.destroy()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun configure(view: WebView) {
        // chrome://inspect can attach to debug builds only; release builds keep the WebView closed.
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        view.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(true)
            javaScriptCanOpenWindowsAutomatically = true
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
        }
        view.setBackgroundColor(Color.BLACK)
        view.overScrollMode = View.OVER_SCROLL_NEVER
        // Keeps the sign-in between launches, and lets sign-in pop-ups share it.
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            setAcceptThirdPartyCookies(view, true)
        }
    }

    private fun openExternally(uri: Uri) {
        try {
            context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
            // Nothing on the phone handles it.
        }
    }

    /**
     * The server's pages and sign-in redirects stay in the WebView; links the listener taps
     * that leave the server open in the browser, as do other schemes (mailto:, ...). Plain
     * http only reaches the server and local-network addresses (see [WebPolicy]).
     */
    private fun shouldStay(request: WebResourceRequest, popup: Boolean = false): Boolean {
        val url = request.url.toString()
        val tapped = request.hasGesture() && !request.isRedirect && !popup
        return when (WebPolicy.navigation(url, playerUrl, tapped, request.isForMainFrame)) {
            WebPolicy.Decision.STAY -> true
            WebPolicy.Decision.OPEN_EXTERNALLY -> {
                openExternally(request.url)
                false
            }
            WebPolicy.Decision.BLOCK -> false
        }
    }

    /** Sub-resources (images, scripts, frames) over plain http to anywhere but the server or the LAN are refused. */
    private fun blockedLoad(request: WebResourceRequest): WebResourceResponse? {
        if (WebPolicy.allowsLoad(request.url.toString(), playerUrl)) return null
        return WebResourceResponse("text/plain", "utf-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    private inner class MainClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = !shouldStay(request)

        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            blockedLoad(request)

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (url != "about:blank") loadFailed = false
            if (bridge.needsManualInjection) view.evaluateJavascript(WebScripts.SOURCE, null)
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (bridge.needsManualInjection) view.evaluateJavascript(WebScripts.SOURCE, null)
            if (!loadFailed) callbacks.onFailure(null)
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame) return
            val description = error.description?.toString().orEmpty()
            if (description.contains("ERR_ABORTED")) return
            loadFailed = true
            callbacks.onFailure(ErrorText.friendly(description))
            // Hide the browser's own error page behind our card.
            view.post { view.loadUrl("about:blank") }
        }

        // A proxy answering 502/503/504 while the server restarts: say so instead of showing its error page.
        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, errorResponse: WebResourceResponse) {
            if (!request.isForMainFrame || errorResponse.statusCode !in 500..599) return
            loadFailed = true
            callbacks.onFailure(ErrorText.httpStatus(errorResponse.statusCode))
        }

        // Without this, a renderer crash takes the whole app down. Tell the screen to build a new WebView.
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            callbacks.onRenderGone(detail.didCrash())
            return true
        }
    }

    private inner class MainChrome : WebChromeClient() {
        // Pages that open a new window (Apple Music's sign-in) get a dialog that shares this
        // WebView's session, so window.opener keeps working.
        override fun onCreateWindow(view: WebView, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message): Boolean {
            val child = WebView(context)
            configure(child)
            child.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
                    !shouldStay(request, popup = true)

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    blockedLoad(request)

                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    callbacks.onPopup(null)
                    return true
                }
            }
            child.webChromeClient = object : WebChromeClient() {
                override fun onCloseWindow(window: WebView) {
                    callbacks.onPopup(null)
                }
            }
            (resultMsg.obj as WebView.WebViewTransport).webView = child
            resultMsg.sendToTarget()
            callbacks.onPopup(child)
            return true
        }

        override fun onCloseWindow(window: WebView) {
            callbacks.onPopup(null)
        }

        // alert()/confirm() from the page.
        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            AlertDialog.Builder(context)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            AlertDialog.Builder(context)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }
    }
}
