import SwiftUI

@main
struct CadenceApp: App {
    init() {
        // Declare that this app plays music, so it keeps playing when the screen locks or
        // the app is in the background. The session is switched on when music starts.
        AudioSessionController.shared.configure()
    }

    var body: some Scene {
        WindowGroup { RootView() }
    }
}

struct RootView: View {
    /// The server being used. Empty means "ask for one".
    @AppStorage("serverURL") private var serverURL = ""
    /// The last server that connected, kept so "Change server" starts with it filled in.
    @AppStorage("lastServerURL") private var lastServer = ""

    var body: some View {
        if let url = ServerAddress.playerURL(from: serverURL) {
            PlayerView(url: url, onChangeServer: { serverURL = "" })
        } else {
            ConnectView(serverURL: $serverURL, lastServer: $lastServer)
        }
    }
}
