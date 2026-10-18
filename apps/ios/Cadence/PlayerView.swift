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
            WebPlayer(url: url, reloadToken: reloadToken, failure: $failure)
                .ignoresSafeArea(.container, edges: .bottom)
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

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.websiteDataStore = .default() // keeps the sign-in between launches
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true
        web.isOpaque = false
        web.backgroundColor = .black
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.pulledToRefresh(_:)), for: .valueChanged)
        web.scrollView.refreshControl = refresh
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

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate {
        var parent: WebPlayer
        var loadedToken: Int
        weak var web: WKWebView?

        init(_ parent: WebPlayer) {
            self.parent = parent
            self.loadedToken = parent.reloadToken
        }

        @objc func pulledToRefresh(_ sender: UIRefreshControl) {
            web?.reload()
            sender.endRefreshing()
        }

        func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
            show(error)
        }

        func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
            show(error)
        }

        private func show(_ error: Error) {
            if (error as NSError).code == NSURLErrorCancelled { return }
            parent.failure = error.localizedDescription
        }

        // Sign-ins (the OIDC provider, Spotify) navigate in place and redirect
        // back to /app; only links that ask for a new window open in Safari.
        func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                     for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
            if let url = navigationAction.request.url { UIApplication.shared.open(url) }
            return nil
        }
    }
}
