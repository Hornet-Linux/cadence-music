import SwiftUI
import WebKit

/// Hosts the server's web player (/app), so the iOS app shares its UI and
/// sign-in redirects. The lock screen and Control Center come from the page's
/// Media Session metadata (src/player/integrations.ts), published by WebKit.
struct PlayerView: View {
    let url: URL
    let onChangeServer: () -> Void
    @State private var failure: String?
    @State private var reloadToken = 0
    @State private var monitor: NetworkMonitor?
    @State private var release: ReleaseInfo?
    @Environment(\.openURL) private var openURL

    private let updates = UpdateChecker()

    private var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? ""
    }

    var body: some View {
        ZStack {
            Color(uiColor: Palette.uiColor(Palette.playerBackground)).ignoresSafeArea()
            // Only the container safe areas are ignored: the web page handles the notch and the home
            // indicator itself (viewport-fit=cover and env(safe-area-inset-*)), while the keyboard
            // still shrinks the view so a focused field stays visible.
            WebPlayer(url: url, reloadToken: reloadToken, failure: $failure, onChangeServer: onChangeServer)
                .ignoresSafeArea(.container)
            if let message = failure {
                FailureCard(host: url.host ?? "", message: message, retry: retry, changeServer: onChangeServer)
            }
        }
        .preferredColorScheme(.dark)
        .onChange(of: failure) { newValue in
            monitor?.stop()
            monitor = nil
            if newValue != nil {
                // Retry on its own when the device comes back online.
                let fresh = NetworkMonitor { retry() }
                fresh.start()
                monitor = fresh
            }
        }
        .task { await checkForUpdate() }
        .alert("A newer version is available", isPresented: updatePresented, presenting: release) { found in
            Button("View release") { openURL(found.pageURL) }
            Button("Later", role: .cancel) {}
        } message: { found in
            Text("Cadence \(found.displayVersion) is out; you have \(currentVersion). "
                + "Updates are not installed automatically: download the new Cadence.ipa from the release page and install it the same way as before.")
        }
    }

    private var updatePresented: Binding<Bool> {
        Binding(
            get: { release != nil },
            set: { shown in
                if !shown { release = nil }
            }
        )
    }

    private func retry() {
        failure = nil
        reloadToken += 1
    }

    /// A gentle once-a-day check, a few seconds after the player opens.
    private func checkForUpdate() async {
        try? await Task.sleep(nanoseconds: 4_000_000_000)
        guard !Task.isCancelled else { return }
        if let found = await updates.check(currentVersion: currentVersion) {
            updates.markNotified(found)
            release = found
        }
    }
}

/// Shown over the player when the server cannot be reached.
private struct FailureCard: View {
    let host: String
    let message: String
    let retry: () -> Void
    let changeServer: () -> Void

    var body: some View {
        ZStack {
            Palette.background.color.ignoresSafeArea()
            GeometryReader { proxy in
                ScrollView {
                    VStack(spacing: 16) {
                        LogoMark()
                        Text("Cannot reach your server")
                            .font(.title2.bold())
                            .foregroundColor(Palette.text.color)
                            .multilineTextAlignment(.center)
                        if !host.isEmpty {
                            Text(host)
                                .font(.subheadline.weight(.semibold))
                                .foregroundColor(Palette.secondaryText.color)
                        }
                        Text(message)
                            .font(.body)
                            .foregroundColor(Palette.secondaryText.color)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Try again", action: retry)
                            .buttonStyle(PrimaryButtonStyle())
                        Button("Change server", action: changeServer)
                            .buttonStyle(SecondaryButtonStyle())
                    }
                    .frame(maxWidth: 420)
                    .padding(24)
                    .frame(maxWidth: .infinity, minHeight: proxy.size.height)
                }
            }
        }
    }
}

struct WebPlayer: UIViewRepresentable {
    let url: URL
    let reloadToken: Int
    @Binding var failure: String?
    let onChangeServer: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        config.websiteDataStore = .default() // keeps the sign-in between launches
        // The page's "Change server" button (Settings, Server) and the playback
        // sync script (PlaybackSync) post here. Only the server's own pages are heard.
        config.userContentController.add(WeakMessageHandler(context.coordinator), name: "cadence")
        if let sync = PlaybackSync.script(serverURL: url) {
            config.userContentController.addUserScript(WKUserScript(
                source: sync, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        // Exposes window.CadenceNative so the AI DJ can use Apple Intelligence on this phone.
        // Both the handler and the script only work for the server's own pages.
        config.userContentController.addScriptMessageHandler(
            AIMessageHandler(serverURL: url), contentWorld: .page, name: "cadenceAI")
        if let script = AIMessageHandler.bridgeScript(serverURL: url) {
            config.userContentController.addUserScript(WKUserScript(
                source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        let background = Palette.uiColor(Palette.playerBackground)
        web.isOpaque = false
        web.backgroundColor = background
        web.scrollView.backgroundColor = background
        web.underPageBackgroundColor = background
        // The player scrolls inside its own panes: the page itself must not bounce, zoom or
        // pull to refresh (a web view has no pull-to-refresh unless one is added, and none is).
        // Insets are .never because the page applies env(safe-area-inset-*) itself
        // (viewport-fit=cover); the view runs edge to edge so those values are real.
        web.scrollView.bounces = false
        web.scrollView.alwaysBounceVertical = false
        web.scrollView.alwaysBounceHorizontal = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.pinchGestureRecognizer?.isEnabled = false
        web.allowsBackForwardNavigationGestures = true
        context.coordinator.web = web
        // Plain http only to the server and local addresses (see WebPolicy). The rules
        // compile asynchronously, so the first load waits for them.
        let serverURL = url
        WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "cadence-http-policy", encodedContentRuleList: WebPolicy.contentRules(server: serverURL)
        ) { [weak web] list, _ in
            DispatchQueue.main.async {
                guard let web else { return }
                if let list { web.configuration.userContentController.add(list) }
                web.load(URLRequest(url: serverURL))
            }
        }
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if coordinator.loadedToken != reloadToken {
            coordinator.loadedToken = reloadToken
            web.load(URLRequest(url: url))
        }
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        web.configuration.userContentController.removeScriptMessageHandler(forName: "cadence")
        web.configuration.userContentController.removeScriptMessageHandler(forName: "cadenceAI", contentWorld: .page)
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        var parent: WebPlayer
        var loadedToken: Int
        weak var web: WKWebView?
        private var popup: UIViewController?

        init(_ parent: WebPlayer) {
            self.parent = parent
            self.loadedToken = parent.reloadToken
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard BridgeOrigin.isTrusted(message.frameInfo, server: parent.url),
                  let body = message.body as? [String: Any], let action = body["action"] as? String
            else { return }
            switch action {
            case "changeServer": parent.onChangeServer()
            case "audioActive": AudioSessionController.shared.activate()
            default: break
            }
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            show(error, in: webView)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            show(error, in: webView)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            if webView === web { parent.failure = nil }
        }

        /// A 404 or 5xx for the player's own page (a server that is down, or not a Cadence server)
        /// would otherwise show a blank error page, so it becomes the "cannot reach" card.
        func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
                     decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
            if webView === web, navigationResponse.isForMainFrame,
               let http = navigationResponse.response as? HTTPURLResponse,
               let responseURL = http.url, let scheme = responseURL.scheme, let host = responseURL.host,
               BridgeOrigin.isTrusted(scheme: scheme, host: host, port: responseURL.port, server: parent.url),
               let message = PlayerFailure.message(forHTTPStatus: http.statusCode) {
                parent.failure = message
                decisionHandler(.cancel)
                return
            }
            decisionHandler(.allow)
        }

        /// The server's pages and sign-in redirects stay; links the listener taps that leave the
        /// server open in Safari, as do other schemes (mailto:, tel:). See WebPolicy.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            guard let url = navigationAction.request.url else { return decisionHandler(.allow) }
            let tapped = navigationAction.navigationType == .linkActivated && webView === web
            let mainFrame = navigationAction.targetFrame?.isMainFrame ?? true
            switch WebPolicy.navigation(url, server: parent.url, userTapped: tapped, mainFrame: mainFrame) {
            case .stay:
                decisionHandler(.allow)
            case .openExternally:
                UIApplication.shared.open(url)
                decisionHandler(.cancel)
            case .block:
                decisionHandler(.cancel)
            }
        }

        /// iOS ends the page's process when memory runs low, which leaves a blank view: load it again.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            guard webView === web else {
                closePopup()
                return
            }
            parent.failure = nil
            if webView.url == nil {
                webView.load(URLRequest(url: parent.url))
            } else {
                webView.reload()
            }
        }

        private func show(_ error: Error, in webView: WKWebView) {
            guard webView === web else { return }
            let nsError = error as NSError
            guard !PlayerFailure.shouldIgnore(domain: nsError.domain, code: nsError.code) else { return }
            parent.failure = PlayerFailure.message(
                domain: nsError.domain, code: nsError.code, fallback: error.localizedDescription)
        }

        // Pages that open a new window (Apple Music's sign-in) get a sheet that
        // shares this web view's session, so window.opener keeps working.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            // A tapped target=_blank link off the server goes to Safari, not a sheet.
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url,
               WebPolicy.navigation(url, server: parent.url, userTapped: true, mainFrame: true) != .stay {
                if url.scheme?.lowercased() != "http" || WebPolicy.allowsLoad(url, server: parent.url) {
                    UIApplication.shared.open(url)
                }
                return nil
            }
            let child = WKWebView(frame: .zero, configuration: configuration)
            child.uiDelegate = self
            child.navigationDelegate = self
            let controller = UIViewController()
            controller.view = child
            let nav = UINavigationController(rootViewController: controller)
            nav.overrideUserInterfaceStyle = .dark
            controller.navigationItem.leftBarButtonItem = UIBarButtonItem(
                systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.closePopup() })
            popup = nav
            topController(from: webView)?.present(nav, animated: true)
            return child
        }

        func webViewDidClose(_ webView: WKWebView) {
            if webView !== web { closePopup() }
        }

        private func closePopup() {
            popup?.dismiss(animated: true)
            popup = nil
        }

        private func topController(from view: UIView) -> UIViewController? {
            var top = view.window?.rootViewController
            while let presented = top?.presentedViewController { top = presented }
            return top
        }

        // alert()/confirm() from the page.
        func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
            guard let top = topController(from: webView) else { return completionHandler() }
            top.present(alert, animated: true)
        }

        func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                     initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
            guard let top = topController(from: webView) else { return completionHandler(false) }
            top.present(alert, animated: true)
        }
    }
}

/// WKUserContentController retains its handlers; this breaks the cycle.
private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?
    init(_ target: WKScriptMessageHandler) { self.target = target }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Answers the page's AI requests (`window.CadenceNative`), but only for the
/// server's own pages. It holds just the server URL, so the controller
/// retaining it is harmless.
final class AIMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    let serverURL: URL

    init(serverURL: URL) {
        self.serverURL = serverURL
    }

    /// The contract the web player expects; Android's shell implements the same one.
    /// It defines `window.CadenceNative` only when the page's origin is the server's,
    /// so third-party pages the web view reaches never see it. Nil if the URL has no usable origin.
    static func bridgeScript(serverURL: URL) -> String? {
        guard let origin = BridgeOrigin.originString(of: serverURL),
              let data = try? JSONSerialization.data(withJSONObject: origin, options: [.fragmentsAllowed]),
              let literal = String(data: data, encoding: .utf8)
        else { return nil }
        return """
        (function () {
          if (window.location.origin !== \(literal)) return;
          window.CadenceNative = {
            aiName: "Apple Intelligence",
            aiAvailable: function () {
              return window.webkit.messageHandlers.cadenceAI.postMessage({ op: "available" });
            },
            aiChatJson: function (requestJson) {
              return window.webkit.messageHandlers.cadenceAI.postMessage({ op: "chat", request: requestJson });
            }
          };
        })();
        """
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard BridgeOrigin.isTrusted(message.frameInfo, server: serverURL) else {
            return replyHandler(nil, "Not available on this page")
        }
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return replyHandler(nil, "Unrecognised request")
        }
        switch op {
        case "available":
            replyHandler(AppleIntelligence.availability().available, nil)
        case "chat":
            guard let request = body["request"] as? String else { return replyHandler(nil, "Missing request") }
            Task {
                do {
                    replyHandler(try await AppleIntelligence.chatJson(requestJSON: request), nil)
                } catch {
                    replyHandler(nil, error.localizedDescription)
                }
            }
        default:
            replyHandler(nil, "Unrecognised request")
        }
    }
}
