import SwiftUI
import WebKit

/// Hosts the server's web player (/app), so the iOS app shares its UI and
/// sign-in redirects. The lock screen and Control Center come from the page's
/// Media Session metadata (src/player/integrations.ts).
struct PlayerView: View {
    let url: URL
    let onChangeServer: () -> Void
    @State private var failure: String?
    @State private var reloadToken = 0

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            WebPlayer(url: url, reloadToken: reloadToken, failure: $failure, onChangeServer: onChangeServer)
                .ignoresSafeArea()
            if let failure {
                VStack(spacing: 14) {
                    Text("Couldn't load your server").font(.headline)
                    Text(failure).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Try again") {
                        self.failure = nil
                        reloadToken += 1
                    }
                    .buttonStyle(.borderedProminent)
                    Button("Change server", action: onChangeServer)
                }
                .padding(24)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 16))
                .padding()
            }
        }
        .preferredColorScheme(.dark)
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
        config.websiteDataStore = .default() // keeps the sign-in between launches
        // The page's "Change server" button (Settings → Server) posts here.
        config.userContentController.add(WeakMessageHandler(context.coordinator), name: "cadence")
        // Exposes window.CadenceNative so the AI DJ can use Apple Intelligence on this phone.
        config.userContentController.addScriptMessageHandler(AIMessageHandler(), contentWorld: .page, name: "cadenceAI")
        config.userContentController.addUserScript(WKUserScript(
            source: AIMessageHandler.bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.isOpaque = false
        web.backgroundColor = .black
        // The player scrolls inside its own panes; the page itself shouldn't bounce or zoom.
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.scrollView.pinchGestureRecognizer?.isEnabled = false
        context.coordinator.web = web
        web.load(URLRequest(url: url))
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
            guard let body = message.body as? [String: Any], body["action"] as? String == "changeServer" else { return }
            parent.onChangeServer()
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

        private func show(_ error: Error, in webView: WKWebView) {
            guard webView === web, (error as NSError).code != NSURLErrorCancelled else { return }
            parent.failure = error.localizedDescription
        }

        // Pages that open a new window (Apple Music's sign-in) get a sheet that
        // shares this web view's session, so window.opener keeps working.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
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

/// Answers the page's AI requests (`window.CadenceNative`). Holds no state, so
/// the controller retaining it is harmless.
final class AIMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    /// The contract the web player expects; Android's shell implements the same one.
    static let bridgeScript = """
    window.CadenceNative = {
      aiName: "Apple Intelligence",
      aiAvailable: function () {
        return window.webkit.messageHandlers.cadenceAI.postMessage({ op: "available" });
      },
      aiChatJson: function (requestJson) {
        return window.webkit.messageHandlers.cadenceAI.postMessage({ op: "chat", request: requestJson });
      }
    };
    """

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
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
